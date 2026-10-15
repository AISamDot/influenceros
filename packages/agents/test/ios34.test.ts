import { json } from '@ios/db';
import { describe, expect, it } from 'vitest';
import { appOrigin, enqueueOnceFor, kitColors, PUBLISH_PREPARE_JOB, loadPersonaKit, parsePalette, personaSiteUrl, shortLinkUrl, SITE_PATHS } from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

describe('IOS-3/4 shared contracts', () => {
  it('builds persona-site and short-link URLs for local dev and for the studio domain', () => {
    expect(appOrigin({})).toBe('http://localhost:3100');
    expect(personaSiteUrl('rosa', SITE_PATHS.home, {})).toBe('http://localhost:3100/p/rosa');
    expect(personaSiteUrl('rosa', SITE_PATHS.freebie, { IOS_PUBLIC_URL: 'https://studio.test/' })).toBe('https://studio.test/p/rosa/free');
    expect(personaSiteUrl('rosa', '/', { IOS_STUDIO_DOMAIN: 'Studio.Example' })).toBe('https://rosa.studio.example/');
    expect(personaSiteUrl('rosa', 'free', { IOS_STUDIO_DOMAIN: 'studio.example' })).toBe('https://rosa.studio.example/free');
    expect(shortLinkUrl('rosa', 'ab12cd', {})).toBe('http://localhost:3100/l/ab12cd');
    expect(shortLinkUrl('rosa', 'ab12cd', { IOS_STUDIO_DOMAIN: 'studio.example' })).toBe('https://rosa.studio.example/l/ab12cd');
  });

  it('enqueues a cross-stream job once per subject', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const job = { kind: PUBLISH_PREPARE_JOB, key: 'slot:1', payload: { slotId: '1' }, personaId: p.id };
    expect(await enqueueOnceFor(t.db, job)).not.toBeNull();
    expect(await enqueueOnceFor(t.db, job)).toBeNull();
    await t.db.query(`UPDATE job SET status = 'succeeded' WHERE kind = $1`, [PUBLISH_PREPARE_JOB]);
    expect(await enqueueOnceFor(t.db, job, { ever: true })).toBeNull();
    expect(await enqueueOnceFor(t.db, job)).not.toBeNull();
    await t.db.close();
  });

  it('reads the palette table from the bible and picks layout colours', async () => {
    const md = `| Palette | Hex | Used for |\n|---|---|---|\n| Espresso | #3B2620 | wood |\n| Oxblood | #6E1F2B | cardigan |\n| Cream | #F2E8D5 | blouse |\n| Aubergine (hair only) | #4B2440 | her hair. **Never on clothing** |\n| Brass gold | #B8913A | accents |`;
    const palette = parsePalette(md);
    expect(palette.map((c) => c.hex)).toEqual(['#3B2620', '#6E1F2B', '#F2E8D5', '#4B2440', '#B8913A']);
    const c = kitColors(palette, null);
    expect(c.bg).toBe('#F2E8D5');
    expect(c.ink).toBe('#3B2620');
    expect([c.accent, c.accent2]).not.toContain('#4B2440');
    expect(kitColors([], '#123456')).toEqual({ bg: '#FAF7F2', ink: '#1C1A17', accent: '#123456', accent2: '#123456' });

    const t = await createTestStudio();
    const p = await makeTestPersona(t, { name: 'Rosa Test' });
    await t.db.query(`INSERT INTO persona_bible (persona_id, version, content, status, created_by) VALUES ($1, 1, $2::jsonb, 'approved', 'test')`, [p.id, json({ look: md })]);
    const kit = await loadPersonaKit(t.db, p.id);
    expect(kit.slug).toBe(p.slug);
    expect(kit.palette).toHaveLength(5);
    expect(kit.colors.bg).toBe('#F2E8D5');
    await t.db.close();
  });
});
