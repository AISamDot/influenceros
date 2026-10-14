import type { Db } from '@ios/db';
import type { PublishProvider } from '@ios/providers';
import { audit } from './audit';
import { PublishBlockedError } from './errors';
import { assertCanPublish } from './killswitch';
import { type Actor, type ApprovalRow, type Platform, SYSTEM } from './types';

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
 * Publishes one post. Order: kill switches + persona state → approval (Owner, auto after the veto window, or
 * auto-approved card) → latest QC passed and Gate not red → provider publish with the AI label → verify.
 */
export async function publishPost(
  db: Db,
  publisher: PublishProvider,
  postId: string,
  actor: Actor = SYSTEM,
): Promise<{ externalId: string; url: string | null }> {
  const post = await db.one<PostRow & { studio_id: string; handle: string | null }>(
    `SELECT po.*, pe.studio_id, a.handle FROM post po
       JOIN persona pe ON pe.id = po.persona_id LEFT JOIN account a ON a.id = po.account_id
      WHERE po.id = $1`,
    [postId],
  );
  await assertCanPublish(db, post.persona_id, post.platform);

  const reasons: string[] = [];
  const approval = post.approval_id
    ? await db.maybeOne<ApprovalRow>('SELECT * FROM approval WHERE id = $1', [post.approval_id])
    : null;
  if (!approval || (approval.status !== 'approved' && approval.status !== 'auto_approved')) {
    reasons.push('post is not approved (or its veto window is still open)');
  }
  const gate = await db.maybeOne<{ verdict: string; released_by: string | null }>(
    `SELECT verdict, released_by FROM gate_result WHERE subject_type = 'post' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [postId],
  );
  if (!gate) reasons.push('no Compliance Gate result');
  else if (gate.verdict === 'red' && !gate.released_by) reasons.push('Compliance Gate: red');
  const qc = await db.maybeOne<{ pass: boolean }>(
    `SELECT pass FROM qc_report WHERE subject_type = 'post' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [postId],
  );
  if (!qc?.pass) reasons.push('QC has not passed');
  if (reasons.length) throw new PublishBlockedError(reasons);

  await db.query(`UPDATE post SET status = 'publishing', updated_at = now() WHERE id = $1`, [postId]);
  const res = await publisher.publish({
    accountRef: post.handle ?? post.account_id ?? 'unknown',
    platform: post.platform,
    mediaUrls: post.media.map((m) => m.url),
    caption: post.caption ?? '',
    aiLabel: true,
  });
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
