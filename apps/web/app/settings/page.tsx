import { activeKillSwitches, PLATFORMS, personaCaps, type PersonaRow } from '@troupe/core';
import Link from 'next/link';
import { Flash } from '@/components/flash';
import { IconPause, IconPlug } from '@/components/icons';
import { SubmitButton } from '@/components/submit-button';
import { studioContext } from '@/lib/server';
import { savePersonaControls, saveStudioSettings } from './actions';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

function Field({ label, name, value, suffix, step = 1, min = 0 }: { label: string; name: string; value: number; suffix?: string; step?: number; min?: number }) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <div className="relative mt-1">
        <input className="input pr-14 tabular-nums" type="number" name={name} defaultValue={value} min={min} step={step} required />
        {suffix ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted">{suffix}</span> : null}
      </div>
    </label>
  );
}

function SwitchForm({ scope, on, personaId, platform, label }: { scope: string; on: boolean; personaId?: string; platform?: string; label: string }) {
  return (
    <form action="/api/kill-switches" method="post" className="flex items-center justify-between gap-3 py-2.5">
      <input type="hidden" name="scope" value={scope} />
      {personaId ? <input type="hidden" name="personaId" value={personaId} /> : null}
      {platform ? <input type="hidden" name="platform" value={platform} /> : null}
      <input type="hidden" name="action" value={on ? 'clear' : 'set'} />
      <span className="flex items-center gap-2 text-[13.5px]">
        <span className={`size-2 rounded-full ${on ? 'bg-danger' : 'bg-ok'}`} />
        {label}
        <span className="text-[12px] text-muted">{on ? 'paused' : 'posting'}</span>
      </span>
      <SubmitButton className={`btn btn-sm ${on ? 'btn-ink' : ''}`}>
        {on ? (
          'Resume'
        ) : (
          <>
            <IconPause size={12} /> Pause
          </>
        )}
      </SubmitButton>
    </form>
  );
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const s = studio.resolved;
  const personas = await db.query<PersonaRow>(`SELECT * FROM persona WHERE studio_id = $1 ORDER BY name`, [studio.id]);
  const switches = await activeKillSwitches(db, studio.id);
  const isOn = (scope: string, target?: string) =>
    switches.some((k) => k.scope === scope && (scope === 'global' || k.persona_id === target || k.platform === target));

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Settings</h1>
          <p className="mt-2 text-muted">Caps, autonomy, approval toggles and kill switches. Every change is audited.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/settings/accounts" className="btn">
            Accounts
          </Link>
          <Link href="/settings/integrations" className="btn">
            <IconPlug size={14} /> Integrations
          </Link>
        </div>
      </div>
      <Flash error={sp.error} ok={sp.ok === 'paused' ? 'Posting paused.' : sp.ok === 'resumed' ? 'Posting resumed.' : sp.ok} />

      <form action={saveStudioSettings} className="card space-y-6 p-5 sm:p-6">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Studio caps</h2>
          <p className="mt-1 text-[12.5px] text-muted">Monthly. Alert at {Math.round(s.alert_threshold * 100)}%, refuse new paid work at 100% until you approve more.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Studio LLM spend" name="llm_usd_month" value={s.caps.llm_usd_month} suffix="USD" />
            <Field label="Studio Higgsfield credits" name="hf_credits_month" value={s.caps.hf_credits_month} suffix="credits" />
            <Field label="Default persona LLM" name="p_llm_usd_month" value={s.persona_default_caps.llm_usd_month} suffix="USD" />
            <Field label="Default persona credits" name="p_hf_credits_month" value={s.persona_default_caps.hf_credits_month} suffix="credits" />
          </div>
        </div>
        <div className="border-t border-line pt-5">
          <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Approvals and autonomy</h2>
          <p className="mt-1 text-[12.5px] text-muted">Kill/retire, spend above caps, plan upgrades and disclosure or legal text always need your explicit approval. That can't be switched off.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex items-center gap-3 rounded-xl border border-line px-3 py-2 sm:col-span-2">
              <input type="checkbox" name="auto_approve_cards" defaultChecked={s.approvals.auto_approve_cards} className="size-4 accent-[var(--ink)]" />
              <span className="text-[13.5px]">
                Auto-approve launch and product v1 cards
                <span className="block text-[12px] text-muted">If you ignore the card, it approves itself after the window.</span>
              </span>
            </label>
            <Field label="Card window" name="auto_approve_hours" value={s.approvals.auto_approve_hours} suffix="hours" min={1} />
            <Field label="Post veto window" name="post_veto_window_minutes" value={s.approvals.post_veto_window_minutes} suffix="min" />
            <label className="block">
              <span className="text-[12px] font-medium text-muted">Default autonomy for new personas</span>
              <select name="default_autonomy" defaultValue={s.default_autonomy} className="input mt-1">
                <option value="L0">L0 · approve every post</option>
                <option value="L1">L1 · exceptions only</option>
                <option value="L2">L2 · autonomous</option>
              </select>
            </label>
          </div>
        </div>
        <div className="flex justify-end">
          <SubmitButton className="btn btn-ink">Save studio settings</SubmitButton>
        </div>
      </form>

      <section className="card p-5 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Personas</h2>
        <p className="mt-1 text-[12.5px] text-muted">Autonomy level and monthly caps per persona.</p>
        <div className="mt-4 divide-y divide-line">
          {personas.map((p) => {
            const caps = personaCaps(p, s);
            return (
              <form key={p.id} action={savePersonaControls} className="grid items-end gap-3 py-3 sm:grid-cols-[1.2fr_1fr_1fr_1fr_auto]">
                <input type="hidden" name="persona_id" value={p.id} />
                <input type="hidden" name="persona_name" value={p.name} />
                <div className="flex items-center gap-2.5 self-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.portrait_url ?? ''} alt="" className="size-9 rounded-full object-cover" />
                  <div>
                    <div className="text-[13.5px] font-semibold">{p.name}</div>
                    <div className="text-[11.5px] text-muted">{p.state.toLowerCase()}</div>
                  </div>
                </div>
                <label className="block">
                  <span className="text-[12px] font-medium text-muted">Autonomy</span>
                  <select name="autonomy" defaultValue={p.autonomy} className="input mt-1">
                    <option value="L0">L0</option>
                    <option value="L1">L1</option>
                    <option value="L2">L2</option>
                  </select>
                </label>
                <Field label="LLM cap" name="llm_usd_month" value={caps.llm_usd_month} suffix="USD" />
                <Field label="Credit cap" name="hf_credits_month" value={caps.hf_credits_month} suffix="cr" />
                <SubmitButton className="btn">Save</SubmitButton>
              </form>
            );
          })}
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Kill switches</h2>
        <p className="mt-1 text-[12.5px] text-muted">Checked before every publish. Pausing takes effect immediately; nothing queued goes out.</p>
        <div className="mt-4 grid gap-6 md:grid-cols-3">
          <div>
            <div className="eyebrow">Everything</div>
            <SwitchForm scope="global" on={isOn('global')} label="All personas" />
          </div>
          <div>
            <div className="eyebrow">Platforms</div>
            <div className="divide-y divide-line">
              {PLATFORMS.map((pl) => (
                <SwitchForm key={pl} scope="platform" platform={pl} on={isOn('platform', pl)} label={pl.charAt(0).toUpperCase() + pl.slice(1)} />
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow">Personas</div>
            <div className="divide-y divide-line">
              {personas.map((p) => (
                <SwitchForm key={p.id} scope="persona" personaId={p.id} on={isOn('persona', p.id)} label={p.name} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Compliance Gate rules</h2>
        <p className="mt-1 text-[12.5px] text-muted">Legal and platform lines only. AI disclosure is the platform minimum: post-level AI flags, the profile AI label, and never denying being AI.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="eyebrow !text-danger">Blocked</div>
            <ul className="mt-2 space-y-1 text-[13.5px]">
              {s.gate.block.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="eyebrow !text-ok">Passes</div>
            <ul className="mt-2 space-y-1 text-[13.5px]">
              {s.gate.pass.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
