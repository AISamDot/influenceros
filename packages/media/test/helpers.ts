import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_RENDER_JOB, type MediaRenderPayload } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { attachSampleBible, planWeek, processSlot } from '@ios/content';
import type { PostFormat } from '@ios/core';
import { createFakeProviders } from '@ios/providers';
import { FakeFaceMatcher, FakeOcr, FakeToolkit, type MediaDeps, setMediaDeps } from '../src';

export const NOW = new Date('2026-10-14T10:00:00Z');
export const NEXT_MONDAY = new Date('2026-10-19T00:00:00Z');

export interface MediaFixture extends TestStudio {
  personaId: string;
  deps: MediaDeps;
  toolkit: FakeToolkit;
  /** Runs one slot of the format through B's pipeline and returns its media.render payload. */
  queued(format: PostFormat): Promise<MediaRenderPayload>;
}

export async function mediaFixture(
  o: { toolkit?: FakeToolkit; face?: FakeFaceMatcher; ocr?: FakeOcr; mishear?: (t: string) => string; budget?: Record<string, number> } = {},
): Promise<MediaFixture> {
  const providers = createFakeProviders({ mishear: o.mishear });
  const t = await createTestStudio({ now: () => NOW, providers });
  const p = await makeTestPersona(t, { name: 'Nora Vale', budget: o.budget });
  await attachSampleBible(t.db, p.id);
  const { slotIds } = await planWeek(t.services, p.id, NEXT_MONDAY);
  const toolkit = o.toolkit ?? new FakeToolkit();
  const deps: MediaDeps = { toolkit, ocr: o.ocr ?? new FakeOcr(), face: o.face ?? new FakeFaceMatcher(), workRoot: mkdtempSync(join(tmpdir(), 'ios-media-test-')) };
  setMediaDeps(t.services, deps);
  const used = new Set<string>();
  return {
    ...t,
    personaId: p.id,
    deps,
    toolkit,
    async queued(format) {
      const rows = await t.db.query<{ id: string }>('SELECT id FROM calendar_slot WHERE persona_id = $1 AND format = $2 ORDER BY slot_at', [p.id, format]);
      const slot = rows.find((r) => !used.has(r.id) && slotIds.includes(r.id));
      if (!slot) throw new Error(`no unused ${format} slot`);
      used.add(slot.id);
      const out = await processSlot(t.services, slot.id);
      if (out.status !== 'media_queued') throw new Error(`slot ${format} did not reach media_queued: ${out.status} ${out.blockReason ?? ''}`);
      const job = await t.db.one<{ payload: MediaRenderPayload }>(`SELECT payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2`, [MEDIA_RENDER_JOB, slot.id]);
      return job.payload;
    },
  };
}
