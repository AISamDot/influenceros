import type { GateCheck, StudioServices } from '@ios/agents';
import { loadPersonaKit } from '@ios/agents';
import { loadPersonaContext, runGate, verdictOf } from '@ios/content';
import { addMessage, findThread, type GateVerdict, notify } from '@ios/core';
import type { Db } from '@ios/db';
import { json } from '@ios/db';
import { oneClickUnsubscribeUrl, ensureList, unsubscribeUrl } from './audience';
import { renderEmail } from './render';
import { getCommerceSettings } from './settings';
import { sitePageUrl, publicEndpointUrl } from './sites';
import { productFileKey } from './store';
import { issueToken } from './tokens';
import { asRecord, asString } from './util';

/**
 * The 5-email welcome sequence (FR-11.2): written by the email-writer agent from the persona's bible, every step
 * Gate-checked (legal/platform lines: no income or health guarantees, no fake scarcity, no fake testimonials), and
 * sent by the due-email job with the unsubscribe link, List-Unsubscribe headers and the physical-address footer.
 * Broadcasts go to the persona's whole Resend audience. Marketing email never sends without a physical address.
 */

export type StepPurpose = 'deliver' | 'quick_win' | 'story' | 'offer' | 'invite';
export type CtaTarget = 'download' | 'product' | 'membership' | 'site' | 'none';

export interface EmailStep {
  readonly day: number;
  readonly purpose: StepPurpose;
  readonly subject: string;
  readonly preheader: string;
  readonly body: string;
  readonly cta: { readonly label: string; readonly target: CtaTarget } | null;
  readonly gate?: { readonly verdict: GateVerdict; readonly checks: readonly GateCheck[] };
}

/** Day offsets and jobs of the five welcome emails. */
export const WELCOME_PLAN: ReadonlyArray<{ day: number; purpose: StepPurpose }> = [
  { day: 0, purpose: 'deliver' },
  { day: 1, purpose: 'quick_win' },
  { day: 3, purpose: 'story' },
  { day: 5, purpose: 'offer' },
  { day: 7, purpose: 'invite' },
];

const SEQ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['emails'],
  properties: {
    emails: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'preheader', 'body', 'cta_label'],
        properties: { subject: { type: 'string' }, preheader: { type: 'string' }, body: { type: 'string' }, cta_label: { type: 'string' } },
      },
    },
  },
} as const;

interface WrittenEmail {
  subject: string;
  preheader: string;
  body: string;
  cta_label: string;
}

function parseSequence(v: unknown): WrittenEmail[] {
  const emails = Array.isArray(v) ? v : asRecord(v).emails;
  if (!Array.isArray(emails) || emails.length !== 5) throw new Error('need exactly 5 emails');
  return emails.map((e, i) => {
    const r = asRecord(e);
    const subject = asString(r.subject).trim().slice(0, 120);
    const body = asString(r.body).trim().slice(0, 4000);
    if (!subject || body.length < 40) throw new Error(`email ${i + 1} needs a subject and a body`);
    return { subject, preheader: asString(r.preheader).trim().slice(0, 140), body, cta_label: asString(r.cta_label).trim().slice(0, 40) || 'Take a look' };
  });
}

interface SequenceContext {
  personaId: string;
  studioId: string;
  name: string;
  niche: string;
  leadMagnet: string | null;
  entry: { name: string; slug: string } | null;
  membership: { name: string } | null;
}

function ctaTarget(purpose: StepPurpose, c: SequenceContext): CtaTarget {
  if (purpose === 'deliver') return 'download';
  if (purpose === 'offer') return c.entry ? 'product' : 'site';
  if (purpose === 'invite') return c.membership ? 'membership' : c.entry ? 'product' : 'site';
  return 'none';
}

/** Deterministic copy for fake mode and tests. Plain, specific, and inside the Gate's lines. */
export function fakeWelcome(c: SequenceContext): WrittenEmail[] {
  const lm = c.leadMagnet ?? `my free ${c.niche} starter guide`;
  const entry = c.entry?.name ?? `my ${c.niche} toolkit`;
  return [
    {
      subject: `Here's ${lm}`,
      preheader: 'Your download is inside.',
      body: `Hi {{first_name}},\n\nThanks for joining. Here's ${lm}, as promised. Start with the first page: it takes about ten minutes.\n\nI'm ${c.name}, an AI creator who shares practical ${c.niche} ideas. Over the next week I'll send a few short emails with the things I wish everyone knew on day one.`,
      cta_label: 'Download it',
    },
    {
      subject: 'One small thing to try today',
      preheader: 'Ten minutes, no gear.',
      body: `Hi {{first_name}},\n\nHere's a quick win for today: pick one page from the guide and do just that page. Small, finished steps beat big plans that never start.\n\nReply and tell me which page you picked. I read every reply.`,
      cta_label: '',
    },
    {
      subject: `Why I care about ${c.niche}`,
      preheader: 'The idea behind everything I share.',
      body: `Hi {{first_name}},\n\nMost ${c.niche} advice is either too vague to use or too complicated to keep up. I try to share systems you can run on a busy week.\n\nThat's the idea behind everything I post: simple routines, written down, that you can repeat.`,
      cta_label: '',
    },
    {
      subject: `If you want the full system`,
      preheader: `${entry}, in one place.`,
      body: `Hi {{first_name}},\n\nIf the free guide helped, ${entry} puts the whole system in one place: the templates, the trackers and the step-by-step pages.\n\nIt's there whenever you want it. If it's not for you right now, keep using the free guide.`,
      cta_label: 'See what is inside',
    },
    {
      subject: c.membership ? `Want a new pack every month?` : `What's next`,
      preheader: c.membership ? `The ${c.membership.name}.` : 'Where to go from here.',
      body: c.membership
        ? `Hi {{first_name}},\n\nEvery month I put together a new pack for members of the ${c.membership.name}: fresh templates, a monthly challenge and the trackers to go with it.\n\nYou can join or cancel at any time.`
        : `Hi {{first_name}},\n\nThat's the end of the welcome series. From here you'll get my occasional emails with new ideas and new resources.\n\nAll my free and paid resources are on my page.`,
      cta_label: c.membership ? 'Join the members' : 'Visit my page',
    },
  ];
}

async function sequenceContext(db: Db, personaId: string): Promise<SequenceContext> {
  const p = await db.one<{ id: string; studio_id: string; name: string; niche: string }>('SELECT id, studio_id, name, niche FROM persona WHERE id = $1', [personaId]);
  const products = await db.query<{ name: string; slug: string; ladder_rung: string; status: string }>(
    `SELECT name, slug, ladder_rung, status FROM product WHERE persona_id = $1 AND status IN ('approved','live') ORDER BY created_at`,
    [personaId],
  );
  const entry = products.find((x) => x.status === 'live' && ['entry', 'core_bundle', 'addon'].includes(x.ladder_rung));
  const membership = products.find((x) => x.status === 'live' && x.ladder_rung === 'membership');
  return {
    personaId,
    studioId: p.studio_id,
    name: p.name,
    niche: p.niche,
    leadMagnet: products.find((x) => x.ladder_rung === 'lead_magnet')?.name ?? null,
    entry: entry ? { name: entry.name, slug: entry.slug } : null,
    membership: membership ? { name: membership.name } : null,
  };
}

async function gateSteps(services: StudioServices, c: SequenceContext, written: WrittenEmail[]): Promise<EmailStep[]> {
  const out: EmailStep[] = [];
  for (const [i, e] of written.entries()) {
    const plan = WELCOME_PLAN[i]!;
    const purpose = plan.purpose;
    const g = await runGate(services, {
      studioId: c.studioId,
      personaId: c.personaId,
      input: { kind: 'caption', text: `${e.subject}\n${e.preheader}\n${e.body}`, purpose: purpose === 'offer' || purpose === 'invite' ? 'sell' : 'trust' },
      costRef: { type: 'persona', id: c.personaId },
      label: `gate: welcome email ${i + 1}`,
    });
    const target = ctaTarget(purpose, c);
    out.push({
      day: plan.day,
      purpose,
      subject: e.subject,
      preheader: e.preheader,
      body: e.body,
      cta: target === 'none' || !e.cta_label ? (target === 'download' ? { label: 'Download it', target } : null) : { label: e.cta_label, target },
      gate: { verdict: g.verdict, checks: g.checks },
    });
  }
  return out;
}

/**
 * Writes (or rewrites) the persona's welcome sequence. A red step gets one rewrite with the Gate's findings; still
 * red, the sequence is kept as a draft and the Owner is told. Otherwise it becomes the active sequence (the previous
 * one is paused; enrolled subscribers continue on the new copy).
 */
export async function writeWelcomeSequence(services: StudioServices, personaId: string): Promise<{ sequenceId: string; status: 'active' | 'draft'; verdict: GateVerdict }> {
  const { db } = services;
  const c = await sequenceContext(db, personaId);
  const ctx = await loadPersonaContext(db, personaId);
  const system = `You are the Email Writer for ${c.name}, an openly AI creator in ${c.niche}. Write a 5-email welcome sequence in the persona's voice.
English only. Plain text bodies (paragraphs separated by a blank line; {{first_name}} may be used). Short, warm, specific, useful.
Email 1 delivers the free lead magnet; 2 a quick win; 3 the persona's point of view; 4 a soft offer of the entry product; 5 an invitation (membership if there is one).
Legal lines (the Compliance Gate blocks these): no income, savings or health guarantees, no fabricated results or testimonials, no fake
credentials, no invented deadlines, countdowns or stock limits. The persona is an AI creator and never claims to be human.`;
  let feedback = '';
  let steps: EmailStep[] = [];
  const runIds: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await services.runtime.run<WrittenEmail[]>({
      agent: 'email-writer',
      scope: { studioId: c.studioId, personaId },
      label: 'welcome sequence',
      system,
      cached: ctx.cached,
      prompt: `Lead magnet: ${c.leadMagnet ?? 'a free starter guide'}\nEntry product: ${c.entry?.name ?? 'none yet'}\nMembership: ${c.membership?.name ?? 'none'}${feedback ? `\n\nThe Compliance Gate flagged the last draft. Fix these and keep everything else:\n${feedback}` : ''}`,
      maxTokens: 4000,
      jsonSchema: SEQ_SCHEMA,
      parse: (v) => parseSequence(v),
      fake: () => fakeWelcome(c),
      costRef: { type: 'persona', id: personaId },
    });
    runIds.push(res.runId);
    steps = await gateSteps(services, c, res.output);
    const red = steps.flatMap((s, i) => (s.gate?.verdict === 'red' ? s.gate.checks.filter((x) => x.verdict === 'red').map((x) => `Email ${i + 1}: ${x.message}${x.span ? ` ("${x.span}")` : ''}`) : []));
    if (!red.length) break;
    feedback = red.join('\n');
  }
  const verdict = verdictOf(steps.flatMap((s) => s.gate?.checks ?? []));
  const status: 'active' | 'draft' = verdict === 'red' ? 'draft' : 'active';
  const version = (await db.one<{ v: number }>(`SELECT COALESCE(MAX(version), 0)::int + 1 AS v FROM email_sequence WHERE persona_id = $1 AND kind = 'welcome'`, [personaId])).v;
  const seq = await db.transaction(async (tx) => {
    if (status === 'active') await tx.query(`UPDATE email_sequence SET status = 'paused', updated_at = now() WHERE persona_id = $1 AND kind = 'welcome' AND status = 'active'`, [personaId]);
    return tx.one<{ id: string }>(
      `INSERT INTO email_sequence (persona_id, name, kind, steps, status, version, gate_verdict) VALUES ($1, $2, 'welcome', $3::jsonb, $4, $5, $6) RETURNING id`,
      [personaId, `Welcome v${version}`, json(steps), status, version, verdict],
    );
  });
  if (status === 'draft') {
    await notify(db, {
      studioId: c.studioId,
      personaId,
      kind: 'system',
      severity: 'warn',
      title: `${c.name}'s welcome emails were blocked by the Gate`,
      body: 'Two drafts crossed a legal line. New subscribers wait (nothing is sent) until a clean sequence is written; you can rewrite it from Commerce.',
      link: '/commerce',
    });
  } else {
    const thread = await findThread(db, c.studioId, 'monetization').catch(() => null);
    if (thread) {
      await addMessage(db, {
        threadId: thread.id,
        role: 'agent',
        author: 'agent:email-writer',
        body: `${c.name}'s welcome sequence v${version} is live: 5 emails over 7 days (Gate ${verdict}).`,
        personaId,
        meta: { kind: 'notice', runIds, fake: services.runtime.mode === 'fake' },
      });
    }
  }
  return { sequenceId: seq.id, status, verdict };
}

// ─────────────────────────────── Sending ───────────────────────────────

interface DueRow {
  id: string;
  persona_id: string;
  subscriber_id: string;
  kind: string;
  next_step: number;
  started_at: Date;
  email: string;
  first_name: string | null;
  sub_status: string;
  unsub_token: string | null;
  slug: string;
  name: string;
  studio_id: string;
}

async function addressMissing(services: StudioServices, studioId: string): Promise<void> {
  const recent = await services.db.maybeOne(
    `SELECT 1 FROM notification WHERE studio_id = $1 AND title = $2 AND created_at > $3`,
    [studioId, 'Add the physical address for marketing emails', new Date(services.now().getTime() - 86_400_000)],
  );
  if (recent) return;
  await notify(services.db, {
    studioId,
    kind: 'system',
    severity: 'warn',
    title: 'Add the physical address for marketing emails',
    body: 'Welcome emails and broadcasts are waiting: every marketing email must carry a physical postal address (CAN-SPAM). Set it on Commerce.',
    link: '/commerce',
  });
}

async function ctaUrl(services: StudioServices, row: { persona_id: string; slug: string; subscriber_id: string }, target: CtaTarget, now: Date): Promise<string | null> {
  const { db } = services;
  if (target === 'none') return null;
  if (target === 'download') {
    const lm = await db.maybeOne<{ id: string }>(
      `SELECT id FROM product WHERE persona_id = $1 AND ladder_rung = 'lead_magnet' AND status IN ('approved','live') ORDER BY created_at DESC LIMIT 1`,
      [row.persona_id],
    );
    if (lm && (await productFileKey(db, lm.id))) {
      const t = await issueToken(db, { personaId: row.persona_id, purpose: 'download', subscriberId: row.subscriber_id, ref: { productId: lm.id }, now });
      return publicEndpointUrl(row.slug, `/api/public/download?t=${t}`);
    }
    return sitePageUrl(row.slug, '/');
  }
  if (target === 'product') {
    const p = await db.maybeOne<{ slug: string }>(
      `SELECT slug FROM product WHERE persona_id = $1 AND status = 'live' AND ladder_rung IN ('entry','core_bundle','addon') ORDER BY created_at LIMIT 1`,
      [row.persona_id],
    );
    return sitePageUrl(row.slug, p ? `/shop/${p.slug}` : '/');
  }
  if (target === 'membership') {
    const m = await db.maybeOne<{ slug: string }>(`SELECT slug FROM product WHERE persona_id = $1 AND status = 'live' AND ladder_rung = 'membership' LIMIT 1`, [row.persona_id]);
    return sitePageUrl(row.slug, m ? `/shop/${m.slug}` : '/');
  }
  return sitePageUrl(row.slug, '/');
}

/**
 * Sends every sequence email that is due. Each enrolment is claimed before sending (two workers never double-send);
 * enrolments of inactive subscribers stop; a persona without an active sequence waits. Returns the number sent.
 */
export async function sendDueEmails(services: StudioServices, opts: { now?: Date; limit?: number; studioId?: string } = {}): Promise<{ sent: number; waiting: number; blocked: string | null }> {
  const { db } = services;
  const now = opts.now ?? services.now();
  const due = await db.query<DueRow>(
    `SELECT e.id, e.persona_id, e.subscriber_id, e.kind, e.next_step, e.started_at, s.email, s.first_name, s.status AS sub_status, s.unsub_token,
            p.slug, p.name, p.studio_id
       FROM email_enrollment e JOIN subscriber s ON s.id = e.subscriber_id JOIN persona p ON p.id = e.persona_id
      WHERE e.status = 'active' AND e.next_at <= $1 AND ($3::uuid IS NULL OR p.studio_id = $3)
      ORDER BY e.next_at LIMIT $2`,
    [now, opts.limit ?? 100, opts.studioId ?? null],
  );
  let sent = 0;
  let waiting = 0;
  const addressByStudio = new Map<string, string | null>();
  for (const row of due) {
    if (row.sub_status !== 'active' || ['KILLED', 'RETIRED'].includes((await db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [row.persona_id])).state)) {
      await db.query(`UPDATE email_enrollment SET status = 'stopped', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    if (!addressByStudio.has(row.studio_id)) addressByStudio.set(row.studio_id, (await getCommerceSettings(db, row.studio_id)).physicalAddress);
    const address = addressByStudio.get(row.studio_id) ?? null;
    if (!address) {
      await addressMissing(services, row.studio_id);
      waiting += 1;
      continue;
    }
    const seq = await db.maybeOne<{ id: string; steps: EmailStep[] }>(`SELECT id, steps FROM email_sequence WHERE persona_id = $1 AND kind = $2 AND status = 'active'`, [row.persona_id, row.kind]);
    if (!seq) {
      waiting += 1;
      continue;
    }
    const step = seq.steps[row.next_step];
    if (!step) {
      await db.query(`UPDATE email_enrollment SET status = 'completed', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    // Claim: push next_at out so a parallel run skips it; the real next_at is set after the send.
    const claimed = await db.maybeOne(
      `UPDATE email_enrollment SET next_at = $3, updated_at = now() WHERE id = $1 AND next_step = $2 AND status = 'active' AND next_at <= $4 RETURNING id`,
      [row.id, row.next_step, new Date(now.getTime() + 15 * 60_000), now],
    );
    if (!claimed) continue;
    const list = await ensureList(services, row.persona_id);
    const kit = await loadPersonaKit(db, row.persona_id);
    const url = step.cta ? await ctaUrl(services, row, step.cta.target, now) : null;
    const unsub = row.unsub_token ? unsubscribeUrl(row.slug, row.unsub_token) : null;
    const mail = renderEmail({
      personaName: row.name,
      colors: kit.colors,
      preheader: step.preheader,
      body: step.body,
      cta: step.cta && url ? { label: step.cta.label, url } : null,
      footer: { reason: `You're getting this because you joined ${row.name}'s list.`, unsubscribeUrl: unsub, physicalAddress: address },
      vars: row.first_name ? { first_name: row.first_name } : {},
    });
    const headers: Record<string, string> = row.unsub_token
      ? { 'List-Unsubscribe': `<${oneClickUnsubscribeUrl(row.slug, row.unsub_token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : {};
    const res = await services.providers.audience.send({
      from: list.from,
      to: row.email,
      subject: step.subject,
      html: mail.html,
      text: mail.text,
      headers,
      tags: { persona: row.slug, kind: row.kind, step: String(row.next_step + 1) },
    });
    const msg = await db.one<{ id: string }>(
      `INSERT INTO email_message (persona_id, subscriber_id, sequence_id, step, kind, provider_id, subject) VALUES ($1, $2, $3, $4, 'sequence', $5, $6) RETURNING id`,
      [row.persona_id, row.subscriber_id, seq.id, row.next_step, res.id, step.subject],
    );
    await db.query(`INSERT INTO email_event (persona_id, subscriber_id, sequence_id, type, message_id, meta) VALUES ($1, $2, $3, 'sent', $4, $5::jsonb)`, [
      row.persona_id,
      row.subscriber_id,
      seq.id,
      msg.id,
      json({ step: row.next_step + 1 }),
    ]);
    const next = seq.steps[row.next_step + 1];
    if (next) {
      const at = new Date(Math.max(now.getTime(), new Date(row.started_at).getTime() + next.day * 86_400_000));
      await db.query(`UPDATE email_enrollment SET next_step = $2, next_at = $3, updated_at = now() WHERE id = $1`, [row.id, row.next_step + 1, at]);
    } else {
      await db.query(`UPDATE email_enrollment SET next_step = $2, status = 'completed', updated_at = now() WHERE id = $1`, [row.id, row.next_step + 1]);
    }
    sent += 1;
  }
  return { sent, waiting, blocked: waiting && [...addressByStudio.values()].some((a) => !a) ? 'physical_address' : null };
}

// ─────────────────────────────── Broadcasts ───────────────────────────────

/**
 * A broadcast to the persona's whole list (Resend broadcast; Resend fills the unsubscribe link). Gate red blocks it;
 * a missing physical address blocks it.
 */
export async function sendBroadcast(
  services: StudioServices,
  args: { personaId: string; subject: string; body: string; createdBy: string },
): Promise<{ broadcastId: string; status: 'sent' | 'blocked'; verdict: GateVerdict; reason?: string }> {
  const { db } = services;
  const p = await db.one<{ id: string; studio_id: string; name: string; slug: string }>('SELECT id, studio_id, name, slug FROM persona WHERE id = $1', [args.personaId]);
  const subject = args.subject.trim().slice(0, 120);
  const body = args.body.trim().slice(0, 8000);
  const g = await runGate(services, {
    studioId: p.studio_id,
    personaId: p.id,
    input: { kind: 'caption', text: `${subject}\n${body}`, purpose: 'trust' },
    costRef: { type: 'persona', id: p.id },
    label: 'gate: broadcast',
  });
  const settings = await getCommerceSettings(db, p.studio_id);
  const reason = g.verdict === 'red' ? 'gate_red' : !settings.physicalAddress ? 'physical_address' : undefined;
  const row = await db.one<{ id: string }>(
    `INSERT INTO email_broadcast (persona_id, subject, body, gate_verdict, gate_checks, status, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [p.id, subject, body, g.verdict, json(g.checks), reason ? 'blocked' : 'draft', args.createdBy],
  );
  if (reason) {
    if (reason === 'physical_address') await addressMissing(services, p.studio_id);
    return { broadcastId: row.id, status: 'blocked', verdict: g.verdict, reason };
  }
  const list = await ensureList(services, p.id);
  const kit = await loadPersonaKit(db, p.id);
  const mail = renderEmail({
    personaName: p.name,
    colors: kit.colors,
    body,
    footer: { reason: `You're getting this because you joined ${p.name}'s list.`, unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}', physicalAddress: settings.physicalAddress },
    vars: { first_name: '{{{FIRST_NAME|there}}}' },
  });
  const res = await services.providers.audience.sendBroadcast({ audienceId: list.audienceId, from: list.from, subject, html: mail.html, name: `${p.slug}: ${subject}`.slice(0, 100) });
  await db.query(`UPDATE email_broadcast SET status = 'sent', provider_id = $2, sent_at = now() WHERE id = $1`, [row.id, res.id]);
  await db.query(`INSERT INTO email_message (persona_id, broadcast_id, kind, provider_id, subject) VALUES ($1, $2, 'broadcast', $3, $4) ON CONFLICT (provider_id) DO NOTHING`, [p.id, row.id, res.id, subject]);
  return { broadcastId: row.id, status: 'sent', verdict: g.verdict };
}

/** List health per persona (dashboard and tools). */
export async function listStats(db: Db, personaId: string): Promise<{ active: number; pending: number; unsubscribed: number; bounced: number; sequence: { version: number; status: string; verdict: string | null } | null; sent7d: number }> {
  const r = await db.one<{ active: number; pending: number; unsubscribed: number; bounced: number; sent7d: number }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status IN ('unsubscribed','complained'))::int AS unsubscribed, count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
            (SELECT count(*) FROM email_event WHERE persona_id = $1 AND type = 'sent' AND created_at > now() - interval '7 days')::int AS sent7d
       FROM subscriber WHERE persona_id = $1`,
    [personaId],
  );
  const seq = await db.maybeOne<{ version: number; status: string; gate_verdict: string | null }>(
    `SELECT version, status, gate_verdict FROM email_sequence WHERE persona_id = $1 AND kind = 'welcome' ORDER BY (status = 'active') DESC, version DESC LIMIT 1`,
    [personaId],
  );
  return { ...r, sequence: seq ? { version: seq.version, status: seq.status, verdict: seq.gate_verdict } : null };
}
