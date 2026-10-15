/** Small community UI pieces (stream F). */
const TONE: Record<string, string> = {
  crisis: 'border-danger/40 text-danger',
  minor: 'border-danger/40 text-danger',
  legal_press: 'border-danger/40 text-danger',
  abuse: 'border-danger/40 text-danger',
  spam: 'border-line-strong text-muted',
  partnership: 'border-warn/40 text-warn',
  are_you_real: 'border-warn/40 text-warn',
  purchase_intent: 'border-ok/40 text-ok',
  question: 'border-accent/40 text-accent',
};

export function CommunityClassPill({ cls }: { cls: string | null }) {
  const c = cls ?? 'new';
  return <span className={`pill border ${TONE[c] ?? 'border-line-strong text-muted'}`}>{c.replace(/_/g, ' ')}</span>;
}
