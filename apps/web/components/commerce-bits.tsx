import type { StoreStatus } from '@ios/commerce';

const STORE_LABEL: Record<StoreStatus, { label: string; cls: string; hint: string }> = {
  none: { label: 'Not started', cls: 'bg-surface-3 text-muted', hint: 'Becomes a listing pack once approved' },
  listing_pack: { label: 'Listing pack ready', cls: 'bg-warn-soft text-warn', hint: 'Matching the store product' },
  awaiting_listing: { label: 'Create store listing', cls: 'bg-danger-soft text-danger', hint: 'Create it in Lemon Squeezy from the pack, or paste its checkout URL' },
  linked: { label: 'Checkout linked', cls: 'bg-ok-soft text-ok', hint: 'Live with a checkout URL' },
  free: { label: 'Free (email)', cls: 'bg-accent-soft text-accent', hint: 'Delivered by the welcome email' },
};

/** Store status of a product (listing pack / checkout URL). */
export function CommerceStoreBadge({ status }: { status: StoreStatus }) {
  const s = STORE_LABEL[status] ?? STORE_LABEL.none;
  return (
    <span className={`pill ${s.cls}`} title={s.hint}>
      {s.label}
    </span>
  );
}
