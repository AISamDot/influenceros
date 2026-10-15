/** Account status pill for Settings → Accounts and the persona panel (stream F). */
export function AccountStatusPill({ status, aiLabelOk, linked }: { status: string; aiLabelOk: boolean; linked?: boolean }) {
  const tone = status === 'active' ? (aiLabelOk ? 'border-ok/40 text-ok' : 'border-warn/40 text-warn') : status === 'not created' ? 'border-line-strong text-muted' : 'border-line-strong text-muted';
  return (
    <span className={`pill border ${tone}`}>
      {status}
      {status === 'not created' ? '' : aiLabelOk ? ' · AI label on' : ' · AI label pending'}
      {linked ? ' · Zernio' : ''}
    </span>
  );
}
