/* eslint-disable @next/next/no-img-element */
import type { Db } from '@troupe/db';
import { productionOverview } from '@troupe/production';
import Link from 'next/link';

const KIND_LABEL: Record<string, string> = {
  sheet: '5-view sheet',
  detail_strip: 'Detail strip',
  face: 'Face close-up',
  full_body: 'Full body',
  core: 'Core reference',
  bopa_background_grid: 'Backgrounds 3×3',
  bopa_background: 'Background pick',
  bopa_outfit: 'Outfit',
  bopa_pose_grid: 'Poses 2×2',
  bopa_pose: 'Pose pick',
  bopa_angle: 'Angle',
};

/**
 * Persona page panel for stream K (docs/IOS-5-CONTRACTS.md §4): the 5-view character sheet and detail strip, the
 * identity stack and 4 core references, the BOPA look pack, locked locations and the camera styles in rotation, plus
 * the camera and place each recent slot used. A failure here never takes the persona page down.
 */
export async function ProductionPersonaPanel({ db, personaId }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const o = await productionOverview(db, personaId);
    const shown = o.identity.filter((r) => r.status !== 'rejected');
    const image = (r: (typeof shown)[number]) => (typeof r.meta.asset_url === 'string' && !r.meta.fake ? r.meta.asset_url : null);
    return (
      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Production</h2>
          <span className="text-[12px] tabular-nums text-muted">
            Sheet {o.counts.sheet}/2 · identity stack {o.counts.identityStack}/3 · core refs {o.counts.core}/4 · BOPA {o.counts.bopa} · places locked {o.counts.lockedLocations}/{o.locations.length}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="text-muted">Camera styles</dt>
          <dd>{o.cameraStyles.map((c) => c.label).join(' · ')}</dd>
          <dt className="text-muted">Locations</dt>
          <dd>
            {o.locations.length ? (
              o.locations.map((l) => (
                <span key={l.id} className={`mr-2 inline-block ${l.status === 'locked' ? '' : 'text-warn'}`}>
                  {l.place}
                  {l.status === 'locked' ? ` (${l.refs.length} anchors)` : ' (pending)'}
                </span>
              ))
            ) : (
              <span className="text-muted">locked from the World Bible and the bible's settings once the Soul ID is ready</span>
            )}
          </dd>
          <dt className="text-muted">References</dt>
          <dd>Only the persona's own generations; inspiration pins are mood only, never a face.</dd>
        </dl>
        {shown.length ? (
          <div className="mt-4">
            <div className="eyebrow mb-1">Identity and look pack</div>
            <div className="scroll-x flex gap-1.5">
              {shown.map((r) => {
                const url = image(r);
                return url ? (
                  <img key={r.id} src={url} alt={r.label} title={`${KIND_LABEL[r.kind] ?? r.kind}: ${r.label}${r.status === 'candidate' ? ' (candidate: drifted from the face reference)' : ''}`} className={`h-[96px] w-[54px] shrink-0 rounded-md bg-surface-3 object-cover ${r.status === 'candidate' ? 'opacity-50' : ''}`} />
                ) : (
                  <span key={r.id} title={r.label} className="flex h-[96px] w-[54px] shrink-0 items-center justify-center rounded-md bg-surface-3 p-1 text-center text-[9.5px] leading-tight text-muted">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-[12.5px] text-muted">The character sheet, identity stack, core refs and BOPA look pack are made once the Soul ID is ready (daily, through the credit governor).</p>
        )}
        {o.recent.length ? (
          <div className="mt-4">
            <div className="eyebrow mb-1">Recent slots</div>
            <ul className="divide-y divide-line text-[12.5px]">
              {o.recent.map((r) => (
                <li key={r.slotId} className="flex items-center gap-2 py-1.5">
                  <Link href={`/pipeline/${r.slotId}`} className="min-w-0 flex-1 truncate hover:underline">
                    {r.title}
                  </Link>
                  <span className="shrink-0 text-muted">{r.format.replace(/_/g, ' ')}</span>
                  <span className="shrink-0">{r.camera?.replace(/_/g, ' ') ?? '—'}</span>
                  <span className="w-28 shrink-0 truncate text-right text-muted" title={r.location ?? ''}>
                    {r.location ?? '—'}
                    {r.locked ? ' · locked' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  } catch {
    return null;
  }
}
