import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPersonasDir, launchPersonaSlugs } from '@ios/core/seed';
import { describe, expect, it } from 'vitest';
import { embedPending, importPersonas, syncPersonaDocs } from '../src';
import { knowledgeStudio } from './helpers';

describe('launch-persona importer (personas.import)', () => {
  it('adds new persona folders to an existing studio with a launch card, and versions edited bibles', async () => {
    const t = await knowledgeStudio();
    const dir = mkdtempSync(join(tmpdir(), 'ios-personas-'));
    expect(syncPersonaDocs(defaultPersonasDir(), dir)).toEqual(launchPersonaSlugs());

    const first = await importPersonas(t.services, { dir });
    expect(first.map((r) => [r.slug, r.created])).toEqual(launchPersonaSlugs().map((s) => [s, true]));
    const personas = await t.db.query<{ slug: string; state: string; niche: string }>('SELECT slug, state, niche FROM persona ORDER BY slug');
    expect(personas.every((p) => p.state === 'PROPOSED')).toBe(true); // the launch card's timer (or the Owner) moves them on
    const cards = await t.db.query<{ kind: string; mode: string; proposed_by: string }>(`SELECT kind, mode, proposed_by FROM approval WHERE status = 'pending'`);
    expect(cards).toHaveLength(personas.length);
    expect(cards.every((c) => c.kind === 'persona_launch' && c.mode === 'auto_after' && c.proposed_by === 'agent:studio-manager')).toBe(true);
    const threads = await t.db.query(`SELECT 1 FROM chat_thread WHERE kind = 'persona'`);
    expect(threads).toHaveLength(personas.length);

    // The seed Field Brains are retrievable once embedded, with the seed's citations.
    await embedPending(t.services);
    const hits = await t.services.knowledge.retrieve({ studioId: t.studioId, niche: 'dating', query: 'romance scam playbook money gift cards', kinds: ['node'], k: 3 });
    expect(hits.some((h) => /romance-scam/i.test(h.title))).toBe(true);
    expect(hits.find((h) => /romance-scam/i.test(h.title))!.citations.length).toBeGreaterThan(0);

    // Nothing changed: no new versions.
    const again = await importPersonas(t.services, { dir });
    expect(again.every((r) => !r.created && !r.updated && r.bibleVersion === 1)).toBe(true);

    // An edited document becomes bible v2 (delegated to the Studio Manager; the Owner is notified).
    const slug = launchPersonaSlugs()[0]!;
    appendFileSync(join(dir, slug, 'bible.md'), '\n\n## 19. Late note\n\nA new studio note.\n');
    const third = await importPersonas(t.services, { dir });
    expect(third.find((r) => r.slug === slug)).toMatchObject({ created: false, updated: true, bibleVersion: 2 });
    const versions = await t.db.query<{ version: number; status: string }>(
      `SELECT b.version, b.status FROM persona_bible b JOIN persona p ON p.id = b.persona_id WHERE p.slug = $1 ORDER BY b.version`,
      [slug],
    );
    expect(versions).toEqual([{ version: 1, status: 'superseded' }, { version: 2, status: 'approved' }]);
    const note = await t.db.one<{ title: string }>(`SELECT title FROM notification WHERE title LIKE '%bible v2 imported'`);
    expect(note.title).toMatch(/bible v2 imported$/);
    expect(readFileSync(join(dir, slug, 'bible.md'), 'utf8')).toContain('Late note');
  });

  it('does nothing without persona folders', async () => {
    const t = await knowledgeStudio();
    expect(await importPersonas(t.services, { dir: mkdtempSync(join(tmpdir(), 'ios-empty-')) })).toEqual([]);
  });
});
