import type { Db } from '@ios/db';
import type { PublishProvider } from '@ios/providers';
import { audit } from './audit';
import { PublishBlockedError } from './errors';
import { assertCanPublish } from './killswitch';
import { notify } from './notifications';
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
 * publish with the AI label and the post id as idempotency key → record the external id → verify. If verify throws
 * or the provider is still processing, the post stays 'publishing' and recoverPublishing() finishes it.
 */
export async function publishPost(
  db: Db,
  publisher: PublishProvider,
  postId: string,
  actor: Actor = SYSTEM,
): Promise<{ externalId: string; url: string | null; status: 'live' | 'failed' | 'verifying' }> {
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
    `UPDATE post SET status = 'publishing', publishing_at = now(), verify_attempts = 0, verify_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'scheduled' RETURNING id`,
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
    await db.query(`UPDATE post SET status = 'scheduled', publishing_at = NULL, updated_at = now() WHERE id = $1 AND status = 'publishing'`, [postId]);
    throw err;
  }
  // Record the external id before verifying, so a verify failure (or a crash) leaves enough to recover from.
  await db.query(`UPDATE post SET external_id = $2, updated_at = now() WHERE id = $1 AND status = 'publishing'`, [postId, res.externalId]);
  const ctx = { studioId: post.studio_id, personaId: post.persona_id, platform: post.platform };
  let verified: Awaited<ReturnType<PublishProvider['verify']>>;
  try {
    verified = await publisher.verify(res.externalId);
  } catch (err) {
    // The post is (probably) up but unconfirmed: it stays 'publishing' and recoverPublishing() re-verifies it.
    await markVerifyPending(db, postId, err);
    await audit(db, {
      ...auditBase(ctx, actor, postId),
      action: 'post.verify_deferred',
      data: { platform: post.platform, external_id: res.externalId, error: errorText(err) },
    });
    return { externalId: res.externalId, url: null, status: 'verifying' };
  }
  const outcome = await applyVerification(db, ctx, postId, res.externalId, verified, actor);
  return { externalId: res.externalId, url: verified.url, status: outcome };
}

type VerifyResult = Awaited<ReturnType<PublishProvider['verify']>>;
type PostCtx = { studioId: string; personaId: string; platform: Platform };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);
const auditBase = (c: PostCtx, actor: Actor, postId: string) => ({ studioId: c.studioId, personaId: c.personaId, actor, entityType: 'post', entityId: postId });

async function markVerifyPending(db: Db, postId: string, err: unknown): Promise<void> {
  await db.query(
    `UPDATE post SET verify_attempts = verify_attempts + 1, verify_error = $2, updated_at = now() WHERE id = $1 AND status = 'publishing'`,
    [postId, errorText(err)],
  );
}

/** live (with the AI label) → live; failed or missing AI label → failed; processing → stays publishing for recovery. */
async function applyVerification(db: Db, c: PostCtx, postId: string, externalId: string, v: VerifyResult, actor: Actor): Promise<'live' | 'failed' | 'verifying'> {
  if (v.status === 'processing') {
    await markVerifyPending(db, postId, new Error('provider still processing'));
    return 'verifying';
  }
  const live = v.status === 'live' && v.aiLabel;
  const rows = await db.query(
    `UPDATE post SET status = $2, external_id = $3, url = $4, verify_error = NULL,
                     published_at = CASE WHEN $5 THEN now() ELSE published_at END, updated_at = now()
      WHERE id = $1 AND status = 'publishing' RETURNING id`,
    [postId, live ? 'live' : 'failed', externalId, v.url, live],
  );
  if (!rows.length) return live ? 'live' : 'failed';
  await audit(db, {
    ...auditBase(c, actor, postId),
    action: live ? 'post.published' : 'post.verify_failed',
    data: { platform: c.platform, external_id: externalId, url: v.url, ai_flag: v.aiLabel },
  });
  if (!live) {
    await notify(db, {
      studioId: c.studioId,
      personaId: c.personaId,
      kind: 'publish',
      severity: 'warn',
      title: `A ${c.platform} post failed verification`,
      body: v.status === 'live' ? 'It went up without the platform AI label, so it is marked failed.' : 'The platform reports it failed.',
      link: '/pipeline',
    });
  }
  return live ? 'live' : 'failed';
}

/**
 * Recovery for posts stuck in 'publishing' (IOS-1 recheck): run by the `agent.recover_publishing` job.
 * - No external id after `staleMs`: the provider never confirmed the publish (crash or timeout before the
 *   response). The post goes back to 'scheduled'; the next publish re-runs every check, and the idempotency key
 *   (the post id) stops the provider from creating a second post.
 * - External id known: verify again. live → live; failed → failed; still processing or verify throws → try again
 *   later, and after `maxAttempts` mark it failed and tell the Owner.
 */
export async function recoverPublishing(
  db: Db,
  publisher: PublishProvider,
  opts: { now?: Date; staleMs?: number; maxAttempts?: number; limit?: number } = {},
): Promise<{ rescheduled: string[]; live: string[]; failed: string[]; pending: string[] }> {
  const now = opts.now ?? new Date();
  const staleMs = opts.staleMs ?? 5 * 60_000;
  const maxAttempts = opts.maxAttempts ?? 6;
  const out = { rescheduled: [] as string[], live: [] as string[], failed: [] as string[], pending: [] as string[] };
  const stuck = await db.query<{ id: string; external_id: string | null; verify_attempts: number; persona_id: string; studio_id: string; platform: Platform }>(
    `SELECT po.id, po.external_id, po.verify_attempts, po.persona_id, pe.studio_id, po.platform
       FROM post po JOIN persona pe ON pe.id = po.persona_id
      WHERE po.status = 'publishing' AND COALESCE(po.publishing_at, po.updated_at) < $1
      ORDER BY po.publishing_at NULLS FIRST LIMIT $2`,
    [new Date(now.getTime() - staleMs), opts.limit ?? 25],
  );
  const actor: Actor = { type: 'system', id: 'publish-recovery' };
  for (const p of stuck) {
    const c: PostCtx = { studioId: p.studio_id, personaId: p.persona_id, platform: p.platform };
    if (!p.external_id) {
      const rows = await db.query(
        `UPDATE post SET status = 'scheduled', publishing_at = NULL, updated_at = now() WHERE id = $1 AND status = 'publishing' AND external_id IS NULL RETURNING id`,
        [p.id],
      );
      if (rows.length) {
        await audit(db, { ...auditBase(c, actor, p.id), action: 'post.publish_recovered', data: { to: 'scheduled', reason: 'publish never confirmed' } });
        out.rescheduled.push(p.id);
      }
      continue;
    }
    let outcome: 'live' | 'failed' | 'verifying';
    try {
      outcome = await applyVerification(db, c, p.id, p.external_id, await publisher.verify(p.external_id), actor);
    } catch (err) {
      await markVerifyPending(db, p.id, err);
      outcome = 'verifying';
    }
    if (outcome === 'verifying' && p.verify_attempts + 1 >= maxAttempts) {
      const rows = await db.query(
        `UPDATE post SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'publishing' RETURNING id`,
        [p.id],
      );
      if (rows.length) {
        await audit(db, { ...auditBase(c, actor, p.id), action: 'post.verify_failed', data: { external_id: p.external_id, attempts: p.verify_attempts + 1 } });
        await notify(db, {
          studioId: c.studioId,
          personaId: c.personaId,
          kind: 'publish',
          severity: 'warn',
          title: `Couldn't confirm a ${c.platform} post`,
          body: `Verification failed ${p.verify_attempts + 1} times; the post is marked failed. Check it on the platform.`,
          link: '/pipeline',
        });
        outcome = 'failed';
      }
    }
    if (outcome === 'live') out.live.push(p.id);
    else if (outcome === 'failed') out.failed.push(p.id);
    else out.pending.push(p.id);
  }
  return out;
}
