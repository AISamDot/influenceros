import { enqueueOnceFor, PUBLISH_PREPARE_JOB, type PublishPreparePayload, type QcCheck, type RenderedMedia, type StudioServices } from '@troupe/agents';
import { gatePost } from '@troupe/content';
import { ApprovalError, audit, DeferJob, notify, type PostFormat, propose, publishBlockers, PublishBlockedError, publishPost, recoverPublishing } from '@troupe/core';
import { json } from '@troupe/db';
import { AI_FLAG_FIELDS, type Platform } from '@troupe/providers';
import {
  aiPlatformOptions,
  CAPTION_MAX,
  CAROUSEL_SLIDES,
  EXPORT_SIZE,
  isSlideFormat,
  isVideoFormat,
  MAX_VIDEO_S,
  mediaKind,
  PLATFORM_OFFSET_MIN,
  PLATFORM_ORDER,
  platformCaption,
  shortsTitle,
  targetPlatforms,
  TITLE_MAX,
} from './platforms';
import { recordTakedown } from './anomalies';
import { asRecord, asString, HOUR_MS, SYSTEM_PUBLISHER, UUID_RE } from './util';

/**
 * Publishing (PRD FR-7, contracts §5.1):
 *   publish.prepare (E hands over a rendered slot) → one post per target platform ('draft', AI flag on) → post-level
 *   Q4 → Gate (pre_publish) → core propose(post) → slot 'scheduled'.
 *   publish.due (schedule) → publish.post per approved post at its time → vendor upload → core publishPost (kill
 *   switches, approval, Gate, QC, idempotency key = post id, aiLabel true) → verify → post 'live' + URL → slot 'live'.
 */

export const JOB = {
  prepare: PUBLISH_PREPARE_JOB,
  post: 'publish.post',
} as const;

const BLOCK_RETRY_MS = HOUR_MS;
const NO_ACCOUNT_DEFER_MS = 6 * HOUR_MS;
const KILL_DEFER_MS = 30 * 60_000;

interface SlotRow {
  id: string;
  persona_id: string;
  slot_at: Date;
  status: string;
  format: PostFormat;
  cta_keyword: string | null;
  post_id: string | null;
  thumbnail_url: string | null;
  title: string;
  meta: Record<string, unknown>;
  studio_id: string;
  persona_name: string;
  started_at: Date;
}

interface AccountRow {
  id: string;
  platform: Platform;
  handle: string;
  status: string;
}

/** A TikTok slideshow handed over by the render: one stored vertical video, or nothing. */
function slideshowOf(raw: unknown): RenderedMedia | null {
  const m = asRecord(raw);
  if (m.kind !== 'video' || !asString(m.storageKey) || !asString(m.url)) return null;
  return m as unknown as RenderedMedia;
}

/** Validates the payload E enqueued (it crossed a process boundary as JSON). */
export function parsePreparePayload(raw: Record<string, unknown>): PublishPreparePayload {
  const p = asRecord(raw);
  const slotId = asString(p.slotId);
  const personaId = asString(p.personaId);
  if (!UUID_RE.test(slotId) || !UUID_RE.test(personaId)) throw new Error('publish.prepare needs slotId and personaId');
  if (p.aiGenerated !== true) throw new Error('publish.prepare: aiGenerated must be true (every post carries the AI flag)');
  const media = Array.isArray(p.media) ? (p.media as RenderedMedia[]) : [];
  return {
    slotId,
    personaId,
    scriptId: asString(p.scriptId),
    format: asString(p.format) as PostFormat,
    media,
    cover: (p.cover as RenderedMedia | null) ?? null,
    caption: asString(p.caption),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.filter((h): h is string => typeof h === 'string') : [],
    ctaKeyword: asString(p.ctaKeyword),
    aiGenerated: true,
    q4ReportId: asString(p.q4ReportId),
    ...(p.trendingSound === true ? { trendingSound: true } : {}),
    ...(slideshowOf(p.tiktokSlideshow) ? { tiktokSlideshow: slideshowOf(p.tiktokSlideshow)! } : {}),
    ...(asRecord(p.qcOverride).approvalId && UUID_RE.test(asString(asRecord(p.qcOverride).approvalId))
      ? { qcOverride: { approvalId: asString(asRecord(p.qcOverride).approvalId), reason: asString(asRecord(p.qcOverride).reason), stage: asString(asRecord(p.qcOverride).stage) } }
      : {}),
  };
}

/**
 * The Owner-only "publish anyway" card for a post whose QC failed on majors only (FR-21.5/21.6): the QC report, the
 * failing checks with their timestamps or frames, and the publish.prepare payload to run with the override. One open
 * card per slot.
 */
export async function proposeQcOverride(
  services: StudioServices,
  c: {
    studioId: string;
    personaId: string;
    title: string;
    stage: 'Q4' | 'post_Q4';
    reportId: string | null;
    failing: Array<{ check: string; severity: string; message: string; location?: string | null; platform?: string }>;
    prepare: PublishPreparePayload;
    thumbnailUrl: string | null;
  },
): Promise<string | null> {
  if (c.failing.some((f) => f.severity === 'blocker')) return null;
  const open = await services.db.maybeOne<{ id: string }>(`SELECT id FROM approval WHERE kind = 'qc_override' AND status = 'pending' AND payload->'prepare'->>'slotId' = $1`, [c.prepare.slotId]);
  if (open) return open.id;
  const { qcOverride: _old, ...prepare } = c.prepare;
  const a = await propose(services.db, {
    studioId: c.studioId,
    personaId: c.personaId,
    kind: 'qc_override',
    title: c.title.slice(0, 200),
    summary: `QC failed on majors only after the fix loops: ${c.failing.map((f) => `${f.platform ? `${f.platform}: ` : ''}${f.message}`).join('; ')}`.slice(0, 900),
    payload: { stage: c.stage, report_id: c.reportId, failing: c.failing.slice(0, 20), prepare, ...(c.thumbnailUrl ? { thumbnail_url: c.thumbnailUrl } : {}) },
    subjectType: 'calendar_slot',
    subjectId: c.prepare.slotId,
    proposedBy: SYSTEM_PUBLISHER,
  });
  return a.id;
}

async function loadSlot(services: StudioServices, slotId: string): Promise<SlotRow> {
  return services.db.one<SlotRow>(
    `SELECT s.id, s.persona_id, s.slot_at, s.status, s.format, s.cta_keyword, s.post_id, s.thumbnail_url, s.title, s.meta,
            p.studio_id, p.name AS persona_name, COALESCE(p.launched_at, p.created_at) AS started_at
       FROM calendar_slot s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1`,
    [slotId],
  );
}

export interface PrepareResult {
  slotId: string;
  posts: Array<{ postId: string; platform: Platform; status: string; gate?: string; q4?: boolean; approvalId?: string | null; reason?: string; majorsOnly?: boolean; reportId?: string; checks?: QcCheck[] }>;
  skipped: Platform[];
  slotStatus: string;
}

/**
 * publish.prepare: idempotent per slot (a post per (slot, platform) is reused, a post already proposed is left alone).
 * Throws DeferJob when the persona has no active account on any target platform (the Owner creates accounts).
 */
export async function preparePublish(services: StudioServices, payload: PublishPreparePayload): Promise<PrepareResult> {
  const { db } = services;
  const now = services.now();
  const slot = await loadSlot(services, payload.slotId);
  if (slot.persona_id !== payload.personaId) throw new Error('publish.prepare: the slot belongs to another persona');
  const format = (payload.format || slot.format) as PostFormat;
  const existingPosts = await db.query<{ id: string; platform: Platform; status: string }>(
    `SELECT id, platform, status FROM post WHERE calendar_slot_id = $1 ORDER BY created_at`,
    [slot.id],
  );
  if (slot.status === 'live' || slot.status === 'skipped') {
    return { slotId: slot.id, posts: existingPosts.map((p) => ({ postId: p.id, platform: p.platform, status: p.status })), skipped: [], slotStatus: slot.status };
  }

  const slideshow = !isVideoFormat(format) ? (payload.tiktokSlideshow ?? null) : null;
  const targets = targetPlatforms(format, new Date(slot.started_at), now, { slideshow: !!slideshow });
  const accounts = await db.query<AccountRow>(
    `SELECT id, platform, handle, status FROM account WHERE persona_id = $1 AND platform = ANY($2::text[]) AND status = 'active' ORDER BY created_at`,
    [slot.persona_id, targets],
  );
  const byPlatform = new Map<Platform, AccountRow>();
  for (const a of accounts) if (!byPlatform.has(a.platform)) byPlatform.set(a.platform, a);
  const platforms = PLATFORM_ORDER.filter((p) => targets.includes(p) && byPlatform.has(p));
  const skipped = targets.filter((p) => !byPlatform.has(p));
  if (!platforms.length) {
    if (!slot.meta?.accounts_notified) {
      await notify(db, {
        studioId: slot.studio_id,
        personaId: slot.persona_id,
        kind: 'publish',
        severity: 'warn',
        title: `${slot.persona_name} has no active ${targets.join(' / ')} account`,
        body: 'A rendered post is waiting to be published. Create the accounts from the setup sheet and link them in Zernio.',
        link: '/settings/accounts',
      });
      await db.query(`UPDATE calendar_slot SET meta = meta || $2::jsonb WHERE id = $1`, [slot.id, json({ accounts_notified: now.toISOString(), waiting: 'no active account' })]);
    }
    throw new DeferJob(NO_ACCOUNT_DEFER_MS, `waiting: no active account for ${targets.join(', ')}`);
  }

  const kind = mediaKind(format);
  const out: PrepareResult['posts'] = [];
  for (const platform of platforms) {
    const account = byPlatform.get(platform)!;
    let post = existingPosts.find((p) => p.platform === platform);
    if (!post) {
      const caption = platformCaption(platform, payload.caption, payload.hashtags);
      // Stills reach TikTok as the slideshow video (a TikTok photo post can't carry the AI disclosure).
      const asSlideshow = platform === 'tiktok' && !!slideshow;
      const postMedia = asSlideshow ? [slideshow!] : payload.media;
      // Never an inbox draft: a TikTok draft drops the AI disclosure. Trending-sound posts publish directly; the Sound
      // Engine attaches a licensed track (musicSoundInfo) to them.
      const meta = {
        kind: asSlideshow ? 'video' : kind,
        ...(asSlideshow ? { slideshow: true } : {}),
        ...(payload.trendingSound === true && platform === 'tiktok' && kind === 'video' ? { trending_sound: true } : {}),
        title: platform === 'youtube' ? shortsTitle(payload.caption, slot.title) : null,
        mode: 'publish',
        platform_options: aiPlatformOptions(platform),
        cover_url: payload.cover?.url ?? null,
        cover_storage_key: payload.cover?.storageKey ?? null,
        q4_asset_report_id: payload.q4ReportId || null,
        cta_keyword: payload.ctaKeyword || slot.cta_keyword || null,
        source: 'publish.prepare',
      };
      const media = postMedia.map((m) => ({
        url: m.url,
        storage_key: m.storageKey,
        asset_id: m.assetId,
        kind: m.kind,
        content_type: m.contentType,
        width: m.width,
        height: m.height,
        duration_s: m.durationS,
      }));
      const at = new Date(Math.max(new Date(slot.slot_at).getTime(), now.getTime()) + PLATFORM_OFFSET_MIN[platform] * 60_000);
      post = await db.one<{ id: string; platform: Platform; status: string }>(
        `INSERT INTO post (persona_id, account_id, calendar_slot_id, script_id, platform, format, caption, media, thumbnail_url, status, ai_flag, scheduled_at, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'draft', true, $10, $11::jsonb) RETURNING id, platform, status`,
        [slot.persona_id, account.id, slot.id, UUID_RE.test(payload.scriptId) ? payload.scriptId : null, platform, format, caption, json(media), payload.cover?.url ?? null, at, json(meta)],
      );
    }
    if (post.status !== 'draft') {
      out.push({ postId: post.id, platform, status: post.status });
      continue;
    }
    const q4 = await postQ4(services, post.id, { override: payload.qcOverride ?? null });
    if (!q4.pass) {
      const reason = `post Q4: ${q4.checks.filter((c) => !c.pass && c.severity !== 'minor').map((c) => c.message).join('; ')}`;
      await db.query(`UPDATE post SET status = 'blocked', meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, [post.id, json({ blocked_reason: reason.slice(0, 500) })]);
      out.push({ postId: post.id, platform, status: 'blocked', q4: false, reason, majorsOnly: q4.majorsOnly, reportId: q4.reportId, checks: q4.checks });
      continue;
    }
    const gate = await gatePost(services, post.id);
    if (gate.verdict === 'red') {
      const reason = `Compliance Gate red: ${gate.checks.filter((c) => c.verdict === 'red').map((c) => c.message).join('; ')}`;
      await db.query(`UPDATE post SET status = 'blocked', meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, [post.id, json({ blocked_reason: reason.slice(0, 500) })]);
      out.push({ postId: post.id, platform, status: 'blocked', q4: true, gate: 'red', reason });
      continue;
    }
    let approvalId: string | null = null;
    try {
      const a = await propose(db, {
        studioId: slot.studio_id,
        personaId: slot.persona_id,
        kind: 'post',
        title: `${slot.persona_name} · ${platform}: ${slot.title}`.slice(0, 200),
        summary: `${format} post for ${platform}${gate.verdict === 'amber' ? ' (Gate amber)' : ''}. AI flag on.`,
        subjectType: 'post',
        subjectId: post.id,
        gate: gate.verdict,
        proposedBy: SYSTEM_PUBLISHER,
        now,
      });
      approvalId = a.id;
    } catch (err) {
      if (!(err instanceof ApprovalError)) throw err; // already pending or decided: idempotent
    }
    const after = await db.one<{ status: string }>('SELECT status FROM post WHERE id = $1', [post.id]);
    out.push({ postId: post.id, platform, status: after.status, q4: true, gate: gate.verdict, approvalId });
  }

  const passing = out.filter((p) => p.status !== 'blocked');
  let slotStatus: string;
  if (!passing.length) {
    const reason = out.map((p) => `${p.platform}: ${p.reason ?? p.status}`).join(' | ').slice(0, 500);
    await db.query(`UPDATE calendar_slot SET status = 'blocked', block_reason = $2, stage_changed_at = $3 WHERE id = $1`, [slot.id, reason, now]);
    // Post QC failed on majors only (no blocker, no Gate red): the Owner can publish anyway, with a reason (FR-21.6).
    const q4Majors = out.filter((p) => p.q4 === false);
    if (q4Majors.length && q4Majors.length === out.length && q4Majors.every((p) => p.majorsOnly) && !payload.qcOverride) {
      await proposeQcOverride(services, {
        studioId: slot.studio_id,
        personaId: slot.persona_id,
        title: `${slot.persona_name}: publish "${slot.title}" anyway?`,
        stage: 'post_Q4',
        reportId: q4Majors[0]!.reportId ?? null,
        failing: q4Majors.flatMap((p) => (p.checks ?? []).filter((c) => !c.pass && c.severity !== 'minor').map((c) => ({ platform: p.platform, check: c.check, severity: c.severity, message: c.message, location: c.location ?? null }))),
        prepare: payload,
        thumbnailUrl: payload.cover?.url ?? null,
      });
    }
    await notify(db, {
      studioId: slot.studio_id,
      personaId: slot.persona_id,
      kind: 'publish',
      severity: 'warn',
      title: `Blocked before publishing: ${slot.title}`.slice(0, 200),
      body: reason,
      link: '/pipeline',
    });
    slotStatus = 'blocked';
  } else {
    const primary = PLATFORM_ORDER.map((pl) => passing.find((p) => p.platform === pl)).find(Boolean)!;
    await db.query(
      `UPDATE calendar_slot SET status = 'scheduled', post_id = COALESCE(post_id, $2), thumbnail_url = COALESCE(thumbnail_url, $3), block_reason = NULL,
              stage_changed_at = $4, meta = meta - 'waiting'
        WHERE id = $1 AND status NOT IN ('live','skipped')`,
      [slot.id, primary.postId, payload.cover?.url ?? null, now],
    );
    slotStatus = 'scheduled';
  }
  await audit(db, {
    studioId: slot.studio_id,
    personaId: slot.persona_id,
    actor: SYSTEM_PUBLISHER,
    action: 'publish.prepared',
    entityType: 'calendar_slot',
    entityId: slot.id,
    data: { posts: out.map((p) => ({ id: p.postId, platform: p.platform, status: p.status, gate: p.gate ?? null })), skipped },
  });
  return { slotId: slot.id, posts: out, skipped, slotStatus };
}

interface PostForQc {
  id: string;
  persona_id: string;
  platform: Platform;
  format: PostFormat;
  caption: string | null;
  media: Array<{ url?: string; storage_key?: string; width?: number; height?: number; duration_s?: number | null; kind?: string }>;
  thumbnail_url: string | null;
  ai_flag: boolean;
  meta: Record<string, unknown>;
}

/**
 * Post-level Q4 (contracts §5.6): links, caption, hashtags, AI flag and cover, plus the media matching the export
 * sizes and being stored. Blockers and majors fail it; minors are reported only. Writes qc_report (subject 'post',
 * stage Q4) and a qc_defect per failure.
 */
export async function postQ4(services: StudioServices, postId: string, q4opts: { override?: { approvalId: string; reason: string } | null } = {}): Promise<{ pass: boolean; checks: QcCheck[]; reportId: string; majorsOnly: boolean }> {
  const { db } = services;
  const post = await db.one<PostForQc>(`SELECT id, persona_id, platform, format, caption, media, thumbnail_url, ai_flag, meta FROM post WHERE id = $1`, [postId]);
  const caption = post.caption ?? '';
  const checks: QcCheck[] = [];
  const add = (check: string, pass: boolean, severity: QcCheck['severity'], message: string, location?: string) =>
    checks.push({ check, pass, severity, message, ...(location ? { location } : {}) });

  const flagField = AI_FLAG_FIELDS[post.platform];
  const opts = asRecord(post.meta?.platform_options);
  add('ai_flag', post.ai_flag === true && opts[flagField] === true, 'blocker', post.ai_flag && opts[flagField] === true ? `AI flag on (${flagField}).` : `AI flag missing (${flagField} must be true).`);

  const media = post.media ?? [];
  // A TikTok slideshow is a still slot published as one vertical video: it is checked as a video.
  const slideshow = post.meta?.slideshow === true;
  const video = isVideoFormat(post.format) || slideshow;
  const count = media.length;
  const slides = isSlideFormat(post.format) && !slideshow;
  const countOk = !slides ? count === 1 : count >= CAROUSEL_SLIDES.min && count <= CAROUSEL_SLIDES.max;
  add('media_count', countOk, 'blocker', countOk ? `${count} media file(s).` : `${post.format} needs ${!slides ? '1 file' : `${CAROUSEL_SLIDES.min}–${CAROUSEL_SLIDES.max} slides`}, got ${count}.`);
  const size = slides ? EXPORT_SIZE.carousel : EXPORT_SIZE.vertical;
  const wrong = media.findIndex((m) => m.width !== size.width || m.height !== size.height);
  add('export_size', count > 0 && wrong < 0, 'blocker', wrong < 0 ? `Exports at ${size.width}×${size.height}.` : `File ${wrong + 1} is ${media[wrong]?.width}×${media[wrong]?.height}, not ${size.width}×${size.height}.`, wrong >= 0 ? `file ${wrong + 1}` : undefined);
  let missing = -1;
  for (let i = 0; i < media.length && missing < 0; i++) {
    const key = media[i]?.storage_key;
    const ok = key ? !!(await services.providers.storage.localPath(key).catch(() => null)) : /^https:\/\//.test(media[i]?.url ?? '');
    if (!ok) missing = i;
  }
  add('media_stored', count > 0 && missing < 0, 'blocker', missing < 0 ? 'Media files are stored.' : `File ${missing + 1} is missing from storage.`);
  if (video) {
    const d = Number(media[0]?.duration_s ?? 0);
    const max = MAX_VIDEO_S[post.platform];
    add('duration', d > 0 && d <= max, 'blocker', d > 0 && d <= max ? `${d.toFixed(1)} s (≤ ${max} s).` : `Duration ${d || 'unknown'} s is outside 0–${max} s for ${post.platform}.`);
    add('cover', !!(post.thumbnail_url || post.meta?.cover_url), 'major', post.thumbnail_url || post.meta?.cover_url ? 'Cover frame set.' : 'No cover frame.');
  }

  add('caption_length', caption.length > 0 && caption.length <= CAPTION_MAX[post.platform], 'blocker', caption.length && caption.length <= CAPTION_MAX[post.platform] ? `Caption ${caption.length} chars.` : `Caption must be 1–${CAPTION_MAX[post.platform]} chars (got ${caption.length}).`);
  if (post.platform === 'youtube') {
    const title = asString(post.meta?.title);
    add('title', title.length > 0 && title.length <= TITLE_MAX, 'blocker', title && title.length <= TITLE_MAX ? 'Shorts title set.' : `Shorts title must be 1–${TITLE_MAX} chars.`);
  }
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  add('hashtags', tags.length <= 30, tags.length <= 8 ? 'minor' : 'major', `${tags.length} hashtags.`);
  const rawLink = /\bhttps?:\/\/\S+/i.test(caption);
  add('links', !rawLink, 'major', rawLink ? 'Raw link in the caption: links go in the bio or the keyword DM.' : 'No raw links (bio link / keyword DM).');
  const keyword = asString(post.meta?.cta_keyword);
  if (keyword) {
    const has = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(caption);
    add('cta', has, 'major', has ? `CTA keyword "${keyword}" in the caption.` : `CTA keyword "${keyword}" is missing from the caption.`);
  }

  const blockers = checks.some((c) => !c.pass && c.severity === 'blocker');
  const majors = checks.some((c) => !c.pass && c.severity === 'major');
  // An Owner override (qc_override, with a reason) lets majors through; a blocker is never overridable.
  const overridden = !!q4opts.override && majors && !blockers;
  const pass = !blockers && (!majors || overridden);
  const report = await db.one<{ id: string }>(
    `INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, score, pass, details) VALUES ($1, 'post', $2, 'Q4', $3, $4, $5::jsonb) RETURNING id`,
    [post.persona_id, post.id, Math.round((checks.filter((c) => c.pass).length / checks.length) * 100), pass, json({ checks, kind: 'post_q4', ...(overridden ? { override: q4opts.override } : {}) })],
  );
  for (const c of checks.filter((x) => !x.pass)) {
    await db.query(`INSERT INTO qc_defect (qc_report_id, persona_id, type, severity, location, fix_action) VALUES ($1, $2, $3, $4, $5, $6)`, [
      report.id,
      post.persona_id,
      c.check,
      c.severity,
      c.location ?? null,
      c.message,
    ]);
  }
  await db.query(`UPDATE post SET meta = meta || $2::jsonb WHERE id = $1`, [post.id, json({ q4_report_id: report.id, ...(overridden ? { qc_override: q4opts.override } : {}) })]);
  return { pass, checks, reportId: report.id, majorsOnly: majors && !blockers };
}

/**
 * Uploads a post's stored media (and cover) to the vendor once and records the vendor URLs on the post, so a retry
 * never uploads twice. Media without a storage key that is already on https is passed through.
 */
export async function ensureVendorMedia(services: StudioServices, postId: string): Promise<string[]> {
  const { db, providers } = services;
  const post = await db.one<{ media: PostForQc['media']; meta: Record<string, unknown> }>('SELECT media, meta FROM post WHERE id = $1', [postId]);
  const have = Array.isArray(post.meta?.vendor_media_urls) ? (post.meta.vendor_media_urls as string[]) : [];
  if (have.length === post.media.length && have.length) return have;
  const urls: string[] = [];
  for (const m of post.media) {
    if (m.storage_key) {
      const path = await providers.storage.localPath(m.storage_key);
      if (!path) throw new Error(`media ${m.storage_key} is missing from storage`);
      urls.push((await providers.publish.uploadMedia({ filePath: path, contentType: asString((m as { content_type?: string }).content_type, m.kind === 'video' ? 'video/mp4' : 'image/jpeg') })).mediaUrl);
    } else if (m.url && /^https:\/\//.test(m.url)) {
      urls.push(m.url);
    } else {
      throw new Error('a media file has neither a storage key nor a public URL');
    }
  }
  const extra: Record<string, unknown> = { vendor_media_urls: urls };
  const coverKey = asString(post.meta?.cover_storage_key);
  if (coverKey && !post.meta?.vendor_cover_url) {
    const path = await providers.storage.localPath(coverKey);
    if (path) extra.vendor_cover_url = (await providers.publish.uploadMedia({ filePath: path, contentType: 'image/jpeg' })).mediaUrl;
  }
  await db.query(`UPDATE post SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, [postId, json(extra)]);
  return urls;
}

export type PublishOutcome =
  | { status: 'live' | 'verifying' | 'failed'; postId: string; url: string | null; externalId: string }
  | { status: 'skipped'; postId: string; reason: string }
  | { status: 'blocked'; postId: string; reasons: string[] };

/** Marks the slots whose posts went live (publishPost or recovery) as live. Cheap; run on every publish tick. */
export async function syncLiveSlots(services: StudioServices): Promise<number> {
  const rows = await services.db.query(
    `UPDATE calendar_slot s SET status = 'live', stage_changed_at = now()
      WHERE s.status = 'scheduled' AND EXISTS (SELECT 1 FROM post p WHERE p.calendar_slot_id = s.id AND p.status = 'live') RETURNING s.id`,
  );
  return rows.length;
}

/**
 * publish.post: one approved post. Kill switches defer it (it's never published past one); other blocks are recorded
 * on the post and retried after an hour by publish.due.
 */
export async function publishOne(services: StudioServices, postId: string): Promise<PublishOutcome> {
  const { db } = services;
  const post = await db.one<{ id: string; persona_id: string; studio_id: string; platform: Platform; status: string; meta: Record<string, unknown>; calendar_slot_id: string | null }>(
    `SELECT po.id, po.persona_id, pe.studio_id, po.platform, po.status, po.meta, po.calendar_slot_id FROM post po JOIN persona pe ON pe.id = po.persona_id WHERE po.id = $1`,
    [postId],
  );
  if (post.status !== 'scheduled') return { status: 'skipped', postId, reason: `post is ${post.status}` };
  const blockers = await publishBlockers(db, post.persona_id, post.platform);
  if (blockers.length) throw new DeferJob(KILL_DEFER_MS, `waiting: ${blockers.join('; ')}`);
  try {
    await ensureVendorMedia(services, postId);
    const res = await publishPost(db, services.providers.publish, postId, SYSTEM_PUBLISHER);
    await db.query(`UPDATE post SET meta = meta - 'blocked_reason' - 'blocked_at' WHERE id = $1`, [postId]);
    if (res.status === 'live') await syncLiveSlots(services);
    return { status: res.status, postId, url: res.url, externalId: res.externalId };
  } catch (err) {
    if (err instanceof PublishBlockedError) {
      const reasons = [...err.reasons];
      if (/kill switch|is paused|is (?:PROPOSED|SETUP|KILLED|RETIRED)/.test(err.message)) throw new DeferJob(KILL_DEFER_MS, `waiting: ${err.message}`);
      const first = !post.meta?.blocked_at;
      await db.query(`UPDATE post SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, [postId, json({ blocked_reason: err.message.slice(0, 500), blocked_at: services.now().toISOString() })]);
      if (first) {
        await notify(db, {
          studioId: post.studio_id,
          personaId: post.persona_id,
          kind: 'publish',
          severity: 'warn',
          title: `A ${post.platform} post can't publish yet`,
          body: err.message.slice(0, 400),
          link: '/approvals',
        });
      }
      return { status: 'blocked', postId, reasons };
    }
    throw err;
  }
}

/** publish.due: enqueues publish.post for approved posts whose time has come (never past a kill switch). */
export async function enqueueDuePosts(services: StudioServices, now: Date = services.now(), limit = 50): Promise<string[]> {
  const { db } = services;
  const due = await db.query<{ id: string; persona_id: string; platform: Platform; studio_id: string }>(
    `SELECT po.id, po.persona_id, po.platform, pe.studio_id FROM post po JOIN persona pe ON pe.id = po.persona_id
      WHERE po.status = 'scheduled' AND (po.scheduled_at IS NULL OR po.scheduled_at <= $1)
        AND (po.meta->>'blocked_at' IS NULL OR (po.meta->>'blocked_at')::timestamptz <= $2)
      ORDER BY po.scheduled_at NULLS FIRST LIMIT $3`,
    [now, new Date(now.getTime() - BLOCK_RETRY_MS), limit],
  );
  const queued: string[] = [];
  for (const p of due) {
    if ((await publishBlockers(db, p.persona_id, p.platform)).length) continue;
    const job = await enqueueOnceFor(db, { kind: JOB.post, key: `post:${p.id}`, payload: { postId: p.id }, studioId: p.studio_id, personaId: p.persona_id, priority: 60, runAt: now });
    if (job) queued.push(p.id);
  }
  await syncLiveSlots(services);
  return queued;
}

/** Applies a vendor post_status webhook: a live post is confirmed through the same recovery path (status + AI flag). */
export async function applyPostStatus(services: StudioServices, externalId: string, status: 'live' | 'processing' | 'failed'): Promise<string | null> {
  // A live post reported failed afterwards was taken down by the platform: circuit breaker (FR-17.2).
  if (status === 'failed') {
    const live = await services.db.maybeOne<{ id: string }>(`SELECT id FROM post WHERE external_id = $1 AND status = 'live'`, [externalId]);
    if (live && (await recordTakedown(services, externalId))) return live.id;
  }
  const post = await services.db.maybeOne<{ id: string }>(`SELECT id FROM post WHERE external_id = $1 AND status = 'publishing'`, [externalId]);
  if (!post || status === 'processing') return null;
  // Re-verify with the vendor rather than trusting the webhook body (URL and AI flag come from verify()).
  await services.db.query(`UPDATE post SET publishing_at = LEAST(COALESCE(publishing_at, now()), now() - interval '10 minutes') WHERE id = $1`, [post.id]);
  await recoverPublishing(services.db, services.providers.publish, { now: services.now(), limit: 25 });
  await syncLiveSlots(services);
  return post.id;
}

