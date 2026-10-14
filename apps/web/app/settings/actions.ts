'use server';

import { type Autonomy, getSettings, OWNER, updatePersonaControls, updateSettings } from '@ios/core';
import { revalidatePath } from 'next/cache';
import { studioContext } from '@/lib/server';

const num = (f: FormData, k: string, min = 0) => {
  const v = Number(f.get(k));
  if (!Number.isFinite(v) || v < min) throw new Error(`${k} must be a number ≥ ${min}`);
  return v;
};
const autonomy = (v: FormDataEntryValue | null): Autonomy => (v === 'L0' || v === 'L2' ? v : 'L1');

export async function saveStudioSettings(form: FormData): Promise<void> {
  const { db, studio } = await studioContext();
  const current = await getSettings(db, studio.id);
  await updateSettings(
    db,
    studio.id,
    {
      caps: { llm_usd_month: num(form, 'llm_usd_month'), hf_credits_month: num(form, 'hf_credits_month') },
      persona_default_caps: { llm_usd_month: num(form, 'p_llm_usd_month'), hf_credits_month: num(form, 'p_hf_credits_month') },
      approvals: {
        auto_approve_cards: form.get('auto_approve_cards') === 'on',
        auto_approve_hours: num(form, 'auto_approve_hours', 1),
        post_veto_window_minutes: num(form, 'post_veto_window_minutes', 0),
      },
      default_autonomy: autonomy(form.get('default_autonomy')),
      alert_threshold: current.alert_threshold,
    },
    OWNER,
  );
  revalidatePath('/', 'layout');
}

export async function savePersonaControls(form: FormData): Promise<void> {
  const { db } = await studioContext();
  const personaId = String(form.get('persona_id'));
  await updatePersonaControls(
    db,
    personaId,
    {
      autonomy: autonomy(form.get('autonomy')),
      budget: { llm_usd_month: num(form, 'llm_usd_month'), hf_credits_month: num(form, 'hf_credits_month') },
    },
    OWNER,
  );
  revalidatePath('/', 'layout');
}
