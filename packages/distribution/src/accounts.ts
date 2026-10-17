import { enqueueOnceFor, personaSiteUrl, SITE_PATHS, type StudioServices } from '@ios/agents';
import { type Actor, audit } from '@ios/core';
import type { Db } from '@ios/db';
import { json } from '@ios/db';
import type { Platform } from '@ios/providers';
import { DAY_MS } from './util';
import { YOUTUBE_FROM_DAY } from './platforms';

/**
 * Settings → Accounts (PRD FR-7, owner rules): creating platform accounts is an Owner action (Instagram bans automated
 * account creation), so the studio prepares a setup sheet per persona (handle, bio, profile image, link, AI-label
 * steps) and tracks each account: handle, vendor link (Zernio account id in token_ref), status and the platform AI
 * profile label (`ai_label_ok`), which the Gate checks on every post. `accounts.sync` links accounts the Owner
 * connected in Zernio and reads the label where the vendor exposes it.
 */

export const JOB = { sync: 'accounts.sync' } as const;
export const SETUP_PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'youtube'];

export const BIO_MAX: Readonly<Record<Platform, number>> = { tiktok: 80, instagram: 150, youtube: 1000, pinterest: 500 };

/** How to switch on the platform's AI label for the account (the platform minimum; no bio line, no watermark). */
export const AI_LABEL_STEPS: Readonly<Record<Platform, string[]>> = {
  tiktok: [
    'Switch the account to a Creator or Business account (Settings and privacy → Account).',
    "Turn on TikTok's AI-generated content disclosure where the app offers it for the account, and keep the per-post AI label on (the studio sets it on every post).",
    'Connect the account in Zernio, then tick "AI label on" here.',
  ],
  instagram: [
    'Use a Professional (Creator) account linked to the studio Business Portfolio.',
    'Turn on the "AI info" / AI-generated label for the profile where Meta offers it; every post already carries isAiGenerated.',
    'Connect the account in Zernio choosing the Facebook Login option (not "Instagram Login"): the Instagram audio catalog for Reels sounds needs it. Then tick "AI label on" here.',
  ],
  youtube: [
    `Create the channel from day ${YOUTUBE_FROM_DAY} (Shorts start then), phone-verify it and connect it in Zernio.`,
    'Every Short is uploaded with "Altered or synthetic content" (containsSyntheticMedia) on; there is no separate channel label.',
    'Tick "AI label on" here once the channel is connected.',
  ],
  pinterest: ['Pinterest uses one studio account with a board per persona (P2).'],
};

export interface SetupSheetRow {
  platform: Platform;
  accountId: string | null;
  handle: string;
  suggested: boolean;
  bio: string;
  profileImageUrl: string | null;
  link: string;
  aiLabelSteps: string[];
  status: string;
  aiLabelOk: boolean;
  linked: boolean;
  /** YouTube waits for day 30. */
  availableFrom: Date | null;
  /** A setup problem the vendor reported at the last sync (e.g. Instagram connected without Facebook Login). */
  warning: string | null;
}

/** Instagram accounts must be connected in Zernio through Facebook Login (the Instagram audio API requires it). */
export const INSTAGRAM_LOGIN_WARNING =
  'Connected in Zernio with Instagram Login: reconnect it choosing the Facebook Login option. Reels sounds (the Instagram audio catalog) only work on Facebook Login accounts.';

export interface SetupSheet {
  personaId: string;
  name: string;
  slug: string;
  niche: string;
  rows: SetupSheetRow[];
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A handle suggestion: first name + niche word, within platform limits (TikTok/IG: letters, digits, dots, underscores). */
export function suggestHandle(name: string, niche: string, platform: Platform): string {
  const first = clean(name.split(/\s+/)[0] ?? name) || 'creator';
  const word = clean(niche.split(/[\s/&,]+/).find((w) => w.length > 3) ?? niche).slice(0, 10);
  const base = word ? `${first}.${word}` : first;
  return (platform === 'youtube' ? base.replace('.', '') : base).slice(0, 24);
}

/** Fits a bio to a platform limit by whole sentences, keeping the last one (the CTA) when it can. */
export function fitBio(bio: string, max: number): string {
  const text = bio.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const parts = text.match(/[^.!?↓☕]+[.!?↓☕]*\s*/gu)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  let out = '';
  for (const part of parts.slice(0, -1)) {
    const next = [out, part].filter(Boolean).join(' ');
    if ([next, last].filter(Boolean).join(' ').length > max) break;
    out = next;
  }
  const withCta = [out, last].filter(Boolean).join(' ');
  if (withCta && withCta.length <= max) return withCta;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The bible's own bio line (a "Bio" row with the text in backticks), when the bible has one. */
export function bibleBio(content: Record<string, unknown> | null | undefined): string | null {
  const texts: string[] = [];
  let keyed: string | null = null;
  const walk = (v: unknown) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!keyed && /^\**bio\b/i.test(k) && typeof x === 'string' && x.trim().length >= 10) keyed = x.replace(/`/g, '').trim().replace(/^["“]|["”]$/g, '');
        walk(x);
      }
    }
  };
  walk(content ?? {});
  if (keyed) return keyed;
  for (const t of texts) {
    const m = /\*\*Bio[^*|]*\*\*\s*\|\s*`([^`]{10,300})`/i.exec(t);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** The profile bio: the bible's bio when it has one, else what the persona helps with and the CTA. No AI bio line (owner rule). */
export function suggestBio(input: { niche: string; subNiche: string | null; tagline: string | null; leadKeyword: string; bible?: string | null }, platform: Platform): string {
  if (input.bible) return fitBio(input.bible, BIO_MAX[platform]);
  const topic = input.subNiche && !input.subNiche.includes(',') ? input.subNiche : input.niche;
  const what = input.tagline?.trim() || `${topic.charAt(0).toUpperCase()}${topic.slice(1)}: simple systems that actually work`;
  const cta = platform === 'youtube' ? 'New Shorts every week.' : `Comment ${input.leadKeyword} for the free guide ↓`;
  return fitBio(`${what.replace(/\.$/, '')}. ${cta}`, BIO_MAX[platform]);
}

export async function accountSetupSheet(db: Db, personaId: string, now: Date = new Date()): Promise<SetupSheet> {
  const p = await db.one<{ id: string; name: string; slug: string; niche: string; sub_niche: string | null; portrait_url: string | null; started_at: Date }>(
    `SELECT id, name, slug, niche, sub_niche, portrait_url, COALESCE(launched_at, created_at) AS started_at FROM persona WHERE id = $1`,
    [personaId],
  );
  const bible = await db.maybeOne<{ content: Record<string, unknown> }>(
    `SELECT content FROM persona_bible WHERE persona_id = $1 AND status <> 'superseded' ORDER BY version DESC LIMIT 1`,
    [personaId],
  );
  const identity = (bible?.content?.identity ?? {}) as Record<string, unknown>;
  const eng = (bible?.content?.engagement_style ?? {}) as Record<string, unknown>;
  const tagline = typeof identity.tagline === 'string' ? identity.tagline : typeof identity.one_liner === 'string' ? identity.one_liner : null;
  const kw = Array.isArray(eng.comment_keywords) ? (eng.comment_keywords as Array<{ keyword?: string }>).find((k) => typeof k?.keyword === 'string')?.keyword : undefined;
  const accounts = await db.query<{ id: string; platform: Platform; handle: string; status: string; ai_label_ok: boolean; token_ref: string | null; meta: Record<string, unknown> | null }>(
    `SELECT id, platform, handle, status, ai_label_ok, token_ref, meta FROM account WHERE persona_id = $1 ORDER BY created_at`,
    [personaId],
  );
  const link = personaSiteUrl(p.slug, SITE_PATHS.home);
  const rows = SETUP_PLATFORMS.map((platform): SetupSheetRow => {
    const a = accounts.find((x) => x.platform === platform);
    const ytFrom = platform === 'youtube' ? new Date(new Date(p.started_at).getTime() + YOUTUBE_FROM_DAY * DAY_MS) : null;
    return {
      platform,
      accountId: a?.id ?? null,
      handle: a?.handle ?? suggestHandle(p.name, p.niche, platform),
      suggested: !a,
      bio: suggestBio({ niche: p.niche, subNiche: p.sub_niche, tagline, leadKeyword: (kw ?? 'GUIDE').toUpperCase(), bible: bibleBio(bible?.content) }, platform),
      // A generated placeholder (data: URI) is not a usable profile image yet.
      profileImageUrl: p.portrait_url && !p.portrait_url.startsWith('data:') ? p.portrait_url : null,
      link,
      aiLabelSteps: AI_LABEL_STEPS[platform],
      status: a?.status ?? 'not created',
      aiLabelOk: a?.ai_label_ok ?? false,
      linked: !!a?.token_ref && !a.token_ref.startsWith('vault:'),
      availableFrom: ytFrom && ytFrom > now ? ytFrom : null,
      warning: platform === 'instagram' && a?.meta?.login_method === 'instagram_login' ? INSTAGRAM_LOGIN_WARNING : null,
    };
  });
  return { personaId: p.id, name: p.name, slug: p.slug, niche: p.niche, rows };
}

const HANDLE_RE = /^[A-Za-z0-9._]{2,30}$/;
const OWNER_ONLY = (actor: Actor) => {
  if (actor.type !== 'owner') throw new Error('accounts are created and changed by the Owner only');
};

/** Owner: records an account the Owner created on the platform (or updates its handle). Idempotent per persona+platform. */
export async function upsertAccount(services: StudioServices, input: { personaId: string; platform: Platform; handle: string; actor: Actor }): Promise<string> {
  OWNER_ONLY(input.actor);
  const handle = input.handle.trim().replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) throw new Error('handle: 2–30 letters, digits, dots or underscores');
  if (!SETUP_PLATFORMS.includes(input.platform)) throw new Error(`platform must be one of ${SETUP_PLATFORMS.join(', ')}`);
  const { db } = services;
  const studio = await db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [input.personaId]);
  const taken = await db.maybeOne<{ persona_id: string }>(`SELECT persona_id FROM account WHERE platform = $1 AND lower(handle) = lower($2)`, [input.platform, handle]);
  if (taken && taken.persona_id !== input.personaId) throw new Error(`@${handle} is already another persona's ${input.platform} account`);
  const existing = await db.maybeOne<{ id: string }>(`SELECT id FROM account WHERE persona_id = $1 AND platform = $2 AND status <> 'retired' ORDER BY created_at LIMIT 1`, [input.personaId, input.platform]);
  let id: string;
  if (existing) {
    await db.query(`UPDATE account SET handle = $2 WHERE id = $1`, [existing.id, handle]);
    id = existing.id;
  } else {
    id = (await db.one<{ id: string }>(`INSERT INTO account (persona_id, platform, handle, status, two_fa_owner) VALUES ($1, $2, $3, 'pending', 'owner') RETURNING id`, [input.personaId, input.platform, handle])).id;
  }
  await audit(db, { studioId: studio.studio_id, personaId: input.personaId, actor: input.actor, action: existing ? 'account.updated' : 'account.created', entityType: 'account', entityId: id, data: { platform: input.platform, handle } });
  return id;
}

/** Owner: account status, AI profile label and vendor link. */
export async function updateAccount(
  services: StudioServices,
  input: { accountId: string; actor: Actor; status?: 'pending' | 'active' | 'paused' | 'retired'; aiLabelOk?: boolean; vendorRef?: string | null },
): Promise<void> {
  OWNER_ONLY(input.actor);
  const { db } = services;
  const a = await db.one<{ id: string; persona_id: string; studio_id: string }>(`SELECT a.id, a.persona_id, p.studio_id FROM account a JOIN persona p ON p.id = a.persona_id WHERE a.id = $1`, [input.accountId]);
  if (input.vendorRef !== undefined && input.vendorRef !== null && !/^[A-Za-z0-9_\-:.]{1,100}$/.test(input.vendorRef)) throw new Error('vendor account id looks wrong');
  await db.query(
    `UPDATE account SET status = COALESCE($2, status), ai_label_ok = COALESCE($3, ai_label_ok),
            token_ref = CASE WHEN $4::boolean THEN $5 ELSE token_ref END,
            meta = meta || $6::jsonb
      WHERE id = $1`,
    [
      a.id,
      input.status ?? null,
      input.aiLabelOk ?? null,
      input.vendorRef !== undefined,
      input.vendorRef ?? null,
      json(input.aiLabelOk !== undefined ? { ai_label_source: 'owner', ai_label_checked_at: services.now().toISOString() } : {}),
    ],
  );
  await audit(db, {
    studioId: a.studio_id,
    personaId: a.persona_id,
    actor: input.actor,
    action: 'account.updated',
    entityType: 'account',
    entityId: a.id,
    data: { status: input.status ?? null, ai_label_ok: input.aiLabelOk ?? null, vendor_linked: input.vendorRef !== undefined ? !!input.vendorRef : null },
  });
}

export interface SyncResult {
  linked: string[];
  labelUpdated: string[];
  unmatched: Array<{ platform: Platform; handle: string; accountRef: string }>;
  /** Linked accounts with a setup problem (Instagram connected without Facebook Login). */
  warnings: Array<{ accountId: string; platform: Platform; handle: string; warning: string }>;
}

/**
 * accounts.sync: matches the vendor's connected accounts to account rows by platform + handle. A match gets the
 * vendor account id (token_ref), goes active if it was pending, and takes the AI profile label when the vendor reports
 * it. Vendor accounts with no row are listed for the Owner (the studio never creates account rows on its own).
 */
export async function syncAccounts(services: StudioServices): Promise<SyncResult> {
  const { db, providers } = services;
  const out: SyncResult = { linked: [], labelUpdated: [], unmatched: [], warnings: [] };
  const now = services.now().toISOString();
  for (const v of await providers.publish.listAccounts()) {
    const a = await db.maybeOne<{ id: string; token_ref: string | null; status: string; ai_label_ok: boolean; persona_id: string; studio_id: string; meta: Record<string, unknown> | null }>(
      `SELECT a.id, a.token_ref, a.status, a.ai_label_ok, a.persona_id, p.studio_id, a.meta FROM account a JOIN persona p ON p.id = a.persona_id
        WHERE a.platform = $1 AND lower(a.handle) = lower($2) AND a.status <> 'retired' LIMIT 1`,
      [v.platform, v.handle],
    );
    if (!a) {
      out.unmatched.push({ platform: v.platform, handle: v.handle, accountRef: v.accountRef });
      continue;
    }
    const link = a.token_ref !== v.accountRef;
    const label = v.aiProfileLabel !== null && v.aiProfileLabel !== a.ai_label_ok;
    if (v.loginMethod === 'instagram_login') out.warnings.push({ accountId: a.id, platform: v.platform, handle: v.handle, warning: INSTAGRAM_LOGIN_WARNING });
    const login = v.loginMethod ?? null;
    if (!link && !label && a.status !== 'pending' && (a.meta?.login_method ?? null) === login) continue;
    await db.query(
      `UPDATE account SET token_ref = $2, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              ai_label_ok = COALESCE($3, ai_label_ok), meta = meta || $4::jsonb WHERE id = $1`,
      [a.id, v.accountRef, v.aiProfileLabel, json({ synced_at: now, vendor_handle: v.handle, login_method: login, ...(v.aiProfileLabel !== null ? { ai_label_source: 'vendor', ai_label_checked_at: now } : {}) })],
    );
    if (link || a.status === 'pending') out.linked.push(a.id);
    if (label) out.labelUpdated.push(a.id);
    await audit(db, { studioId: a.studio_id, personaId: a.persona_id, actor: { type: 'system', id: 'accounts-sync' }, action: 'account.synced', entityType: 'account', entityId: a.id, data: { linked: link, ai_label_ok: v.aiProfileLabel } });
  }
  return out;
}

export async function enqueueSync(services: StudioServices): Promise<boolean> {
  return !!(await enqueueOnceFor(services.db, { kind: JOB.sync, key: 'accounts:sync', payload: {}, priority: 120, runAt: services.now() }));
}
