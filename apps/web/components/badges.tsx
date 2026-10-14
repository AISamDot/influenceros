import { STATE_LABEL } from '@/lib/format';
import { IconFlag } from './icons';

const STATE_STYLE: Record<string, string> = {
  PROPOSED: 'bg-surface-3 text-muted',
  SETUP: 'bg-surface-3 text-fg',
  TESTING: 'bg-[#e3effc] text-[#1d5fa8] dark:bg-[#132a42] dark:text-[#8cc2ff]',
  RE_ANGLE: 'bg-warn-soft text-warn',
  MONETISING: 'bg-ok-soft text-ok',
  SCALING: 'bg-[#efe8fd] text-[#6b3fd1] dark:bg-[#2a1f4a] dark:text-[#bca4ff]',
  BRAND: 'bg-[#fbf0d9] text-[#8a5a00] dark:bg-[#33270d] dark:text-[#f3c86b]',
  KILLED: 'bg-danger-soft text-danger',
  RETIRED: 'bg-surface-3 text-faint',
};

export function LifecycleBadge({ state }: { state: string }) {
  return (
    <span className={`pill ${STATE_STYLE[state] ?? 'bg-surface-3'}`}>
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

const AUTONOMY_HINT: Record<string, string> = {
  L0: 'Supervised: every post needs your tap',
  L1: 'Exception: green posts auto-publish after the veto window',
  L2: 'Autonomous: green and amber auto-publish, 10% sampled',
};

export function AutonomyBadge({ level }: { level: string }) {
  return (
    <span className="pill border border-line bg-surface text-muted" title={AUTONOMY_HINT[level]}>
      {level}
    </span>
  );
}

export function KillFlag() {
  return (
    <span className="pill bg-danger text-white shadow-[0_0_0_3px_var(--danger-soft)]">
      <IconFlag size={12} strokeWidth={2.4} />
      Kill proposed
    </span>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-faint' }[tone];
  return <span className={`inline-block size-2 rounded-full ${c}`} />;
}
