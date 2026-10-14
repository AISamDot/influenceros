import type { Db } from '@ios/db';
import type { PublishProvider } from '@ios/providers';
import { audit } from './audit';
import { PublishBlockedError } from './errors';
import { assertCanPublish } from './killswitch';
import { latestPostGate } from './policy';
import { type Actor, type ApprovalRow, type Autonomy, type Platform, SYSTEM } from './types';

interface PostRow {
  id: string;
  persona_id: string;
  account_id: string | null;
  platform: Platform;
  caption: string | null;
  media: Array<{ url: string }>;
  status: string;
  approval_id: string | null;
}

/**
 * Publishes one post. Order: kill switches + persona state → the post's own approval (Owner, or auto after the
 * veto window) → latest QC passed and Gate not red (amber needs the Owner unless the persona is L2) → claim the
 * post (scheduled → publishing, atomically, so a retry or a second worker can't publish it twice) → provider
 * publish with the AI label and the post id as idempotency key → verify.
 */
export async function publishPost(
  db: Db,
  publisher: PublishProvider,
  postId: string,
  actor: Actor = SYSTEM,
): Promise<{ externalId: string; url: string | null }> {
  const post = await db.one<PostRow & { studio_id: string; autonomy: Autonomy; handle: string | null }>(
    `SELECT po.*, pe.studio_id, pe.autonomy, a.handle FROM post po
       JOIN persona pe ON pe.id = po.persona_id LEFT JOIN account a ON a.id = po.account_id
      WHERE po.id = $1`,
    [postId],
  );
  await assertCanPublish(db, post.persona_id, post.platform);

  const reasons: string[] = [];
  // The approval must be this post's own (never trust the mutable post.approval_id).
  const approval = await db.maybeOne<ApprovalRow>(
    `SELECT * FROM approval
      WHERE kind = 'post' AND subject_type = 'post' AND subject_id = $1 AND persona_id = $2
        AND status IN ('approved','auto_approved')
      ORDER BY decided_at DESC LIMIT 1`,
    [postId, post.persona_id],
  );
  if (!approval) reasons.push('post is not approved (or its veto window is still open)');
  const gate = await latestPostGate(db, postId);
  const byOwner = (ref: string | null | undefined) => (ref ?? '').startsWith('owner:');
  if (!gate) reasons.push('no Compliance Gate result');
  else if (gate.verdict === 'red' && !byOwner(gate.released_by)) reasons.push('Compliance Gate: red');
  else if (gate.verdict === 'amber' && approval && !byOwner(approval.decided_by) && post.autonomy !== 'L2') {
    reasons.push('Compliance Gate: amber needs the Owner\'s approval');
  }
  const qc = await db.maybeOne<{ pass: boolean }>(
    `SELECT pass FROM qc_report WHERE subject_type = 'post' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [postId],
  );
  if (!qc?.pass) reasons.push('QC has not passed');
  if (reasons.length) throw new PublishBlockedError(reasons);

  const claimed = await db.maybeOne(
    `UPDATE post SET status = 'publishing', updated_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING id`,
    [postId],
  );
  if (!claimed) {
    const now = await db.one<{ status: string }>('SELECT status FROM post WHERE id = $1', [postId]);
    throw new PublishBlockedError([`post is ${now.status}, not scheduled (already published or in flight)`]);
  }
  let res: Awaited<ReturnType<PublishProvider['publish']>>;
  try {
    res = await publisher.publish({
      accountRef: post.handle ?? post.account_id ?? 'unknown',
      platform: post.platform,
      mediaUrls: post.media.map((m) => m.url),
      caption: post.caption ?? '',
      aiLabel: true,
      idempotencyKey: post.id,
    });
  } catch (err) {
    // Hand the post back for a retry; the idempotency key stops the provider from posting it twice.
    await db.query(`UPDATE post SET status = 'scheduled', updated_at = now() WHERE id = $1 AND status = 'publishing'`, [postId]);
    throw err;
  }
  const verified = await publisher.verify(res.externalId);
  const live = verified.status === 'live' && verified.aiLabel;
  await db.query(
    `UPDATE post SET status = $2, external_id = $3, url = $4, published_at = CASE WHEN $5 THEN now() ELSE published_at END, updated_at = now() WHERE id = $1`,
    [postId, live ? 'live' : 'failed', res.externalId, verified.url, live],
  );
  await audit(db, {
    studioId: post.studio_id,
    personaId: post.persona_id,
    actor,
    action: live ? 'post.published' : 'post.verify_failed',
    entityType: 'post',
    entityId: postId,
    data: { platform: post.platform, external_id: res.externalId, url: verified.url, ai_flag: verified.aiLabel },
  });
  return { externalId: res.externalId, url: verified.url };
}
