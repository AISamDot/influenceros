'use server';

import { type Autonomy, getSettings, OWNER, updatePersonaControls, updateSettings } from '@ios/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authOff, currentSession } from '@/lib/auth';
import { studioContext } from '@/lib/server';

const num = (f: FormData, k: string, label: string, min = 0) => {
  const v = Number(f.get(k));
  if (!Number.isFinite(v) || v < min) throw new Error(`${label} must be a number ≥ ${min}`);
  return v;
};
const autonomy = (v: FormDataEntryValue | null): Autonomy => (v === 'L0' || v === 'L2' ? v : 'L1');

/** Runs a save, then returns to Settings with a confirmation or the validation error (never the error page). */
async function save(run: () => Promise<string>): Promise<never> {
  // Server actions post to the page URL: check the Owner's session row here too (sign-out and revocation).
  if (!authOff() && !(await currentSession())) redirect('/login');
  let target: string;
  try {
    target = `/settings?ok=${encodeURIComponent(await run())}`;
  } catch (err) {
    target = `/settings?error=${encodeURIComponent((err as Error).message)}`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

export async function saveStudioSettings(form: FormData): Promise<void> {
  await save(async () => {
    const { db, studio } = await studioContext();
    const current = await getSettings(db, studio.id);
    await updateSettings(
      db,
      studio.id,
      {
        caps: { llm_usd_month: num(form, 'llm_usd_month', 'Studio LLM spend'), hf_credits_month: num(form, 'hf_credits_month', 'Studio credits') },
        persona_default_caps: {
          llm_usd_month: num(form, 'p_llm_usd_month', 'Default persona LLM'),
          hf_credits_month: num(form, 'p_hf_credits_month', 'Default persona credits'),
        },
        approvals: {
          auto_approve_cards: form.get('auto_approve_cards') === 'on',
          auto_approve_hours: num(form, 'auto_approve_hours', 'Card window', 1),
          post_veto_window_minutes: num(form, 'post_veto_window_minutes', 'Post veto window', 0),
        },
        default_autonomy: autonomy(form.get('default_autonomy')),
        alert_threshold: current.alert_threshold,
      },
      OWNER,
    );
    return 'Studio settings saved.';
  });
}

export async function savePersonaControls(form: FormData): Promise<void> {
  await save(async () => {
    const { db } = await studioContext();
    const personaId = String(form.get('persona_id'));
    await updatePersonaControls(
      db,
      personaId,
      {
        autonomy: autonomy(form.get('autonomy')),
        budget: { llm_usd_month: num(form, 'llm_usd_month', 'LLM cap'), hf_credits_month: num(form, 'hf_credits_month', 'Credit cap') },
      },
      OWNER,
    );
    return `${String(form.get('persona_name') ?? 'Persona')} saved.`;
  });
}
