import { requireOwner } from '@/lib/auth';
import { enqueueSlot, pipelineBoard, planWeek, runSlot } from '@ios/content';
import { PUBLISHING_STATES } from '@ios/core';
import { createStudioServices } from '@ios/wiring';
import { backTo, isFormPost, isJson, UUID_RE } from '@/lib/http';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;
const monday = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};

/** GET /api/pipeline?persona=<id>&days=8: the Pipeline board as JSON. */
export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const persona = url.searchParams.get('persona');
  const days = Math.min(21, Math.max(1, Number(url.searchParams.get('days') ?? 8) || 8));
  if (persona && !UUID_RE.test(persona)) return Response.json({ error: 'persona must be a uuid' }, { status: 400 });
  const { db, studio } = await studioContext();
  const now = Date.now();
  const items = await pipelineBoard(db, studio.id, { from: new Date(now - DAY), to: new Date(now + days * DAY), personaId: persona });
  return Response.json({ items });
}

/**
 * POST (JSON or form):
 * - {action: "plan_week", week: "this"|"next", persona_id?}: plans the week now for one or every active persona
 *   and queues each new slot for the pipeline (the scheduler does the same on its own every day);
 * - {action: "run_slot", slot_id}: queues one slot for the pipeline (a slot blocked by repeated pipeline failures is
 *   reopened first).
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  const input: Record<string, string> = isForm
    ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]))
    : ((await req.json().catch(() => ({}))) as Record<string, string>);
  const fail = (error: string, status = 400) => (isForm ? backTo(req, '/pipeline', { error }) : Response.json({ error }, { status }));
  const done = (ok: string, body: Record<string, unknown>) => (isForm ? backTo(req, '/pipeline', { ok }) : Response.json(body));
  const { db, studio } = await studioContext();
  const services = createStudioServices(db);

  if (input.action === 'plan_week') {
    if (input.week !== 'this' && input.week !== 'next') return fail('week must be this or next');
    if (input.persona_id && !UUID_RE.test(input.persona_id)) return fail('persona_id must be a uuid');
    const personas = await db.query<{ id: string }>(
      `SELECT id FROM persona WHERE studio_id = $1 AND state = ANY($2::text[]) AND ($3::uuid IS NULL OR id = $3) ORDER BY name`,
      [studio.id, [...PUBLISHING_STATES], input.persona_id || null],
    );
    if (!personas.length) {
      // Personas in SETUP (the launch wave) aren't planned until they publish: say so instead of a false "done".
      const setup = await db.query<{ name: string; state: string }>(
        `SELECT name, state FROM persona WHERE studio_id = $1 AND ($2::uuid IS NULL OR id = $2) AND state NOT IN ('KILLED','RETIRED') ORDER BY name`,
        [studio.id, input.persona_id || null],
      );
      const who = input.persona_id ? (setup[0] ? `${setup[0].name} is in ${setup[0].state}` : 'that persona is not publishing') : 'No persona is publishing yet';
      return fail(`${who}: weeks are planned once a persona starts publishing (the launch posts are already on the calendar).`, 409);
    }
    const ws = input.week === 'this' ? monday(new Date()) : new Date(monday(new Date()).getTime() + 7 * DAY);
    let created = 0;
    let queued = 0;
    for (const p of personas) {
      const res = await planWeek(services, p.id, ws);
      created += res.created;
      for (const id of res.slotIds) if (await enqueueSlot(services, id, p.id)) queued += 1;
    }
    return done(created ? `${created} posts planned, ${queued} queued` : 'that week is already planned', { created, queued });
  }

  if (input.action === 'run_slot') {
    if (!input.slot_id || !UUID_RE.test(input.slot_id)) return fail('slot_id must be a uuid');
    const slot = await db.maybeOne<{ persona_id: string }>(
      `SELECT s.persona_id FROM calendar_slot s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1 AND p.studio_id = $2`,
      [input.slot_id, studio.id],
    );
    if (!slot) return fail('slot not found', 404);
    const { jobId, reopened } = await runSlot(services, input.slot_id, slot.persona_id);
    return done(jobId ? (reopened ? 'reopened and queued for the pipeline' : 'queued for the pipeline') : 'already queued', { jobId, reopened });
  }

  return fail('action must be plan_week or run_slot');
}
