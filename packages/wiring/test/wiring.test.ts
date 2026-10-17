import { createTestDb } from '@troupe/db/testing';
import { MemoryKeyring } from '@troupe/secrets';
import { describe, expect, it } from 'vitest';
import { allJobs, allSchedules, allTools, createStudioServices, MODULES, providerEnv, resolveProviders } from '../src';

/**
 * Merge guard: after the IOS-2 streams merge, tool names, job kinds, schedule names and live-provider members
 * must still be unique across packages, and the composed services must build.
 */
describe('wiring', () => {
  it('composes every package without duplicate tools, job kinds or schedules', () => {
    expect(Object.keys(MODULES).sort()).toEqual(['agents', 'commerce', 'content', 'distribution', 'formats', 'generator', 'knowledge', 'media', 'production', 'products', 'profit', 'radar', 'world']);
    expect(() => allTools()).not.toThrow();
    expect(() => allJobs()).not.toThrow();
    expect(() => allSchedules()).not.toThrow();
  });

  it('resolves to fakes when no key is present', () => {
    const penv = providerEnv({}, new MemoryKeyring());
    expect(penv.isLive('anthropic')).toBe(false);
    expect(penv.secret('anthropic.api_key')).toBeNull();
    const p = resolveProviders(penv);
    expect(p.llm.name).toBe('fake-llm');
    expect(p.transcribe.name).toBe('fake-whisper');
    expect(p.embeddings.dimensions).toBe(384);
    // IOS-3/4 members exist on the fakes (live overlays come from the stream packages).
    expect(typeof p.audience.ensureAudience).toBe('function');
    expect(typeof p.storage.put).toBe('function');
    // IOS-5 members. Open-Meteo needs no key, so it is live unless fakes are forced.
    expect(p.weather.name).toBe('open-meteo');
    expect(p.pinterest.name).toBe('fake-pinterest');
    const forced = resolveProviders(providerEnv({ TROUPE_FAKE_PROVIDERS: '1' }, new MemoryKeyring()));
    expect(forced.weather.name).toBe('fake-open-meteo');
  });

  it('builds studio services in fake mode', async () => {
    const db = await createTestDb();
    const s = createStudioServices(db, { mode: 'fake', providers: resolveProviders(providerEnv({}, new MemoryKeyring())) });
    expect(s.runtime.mode).toBe('fake');
    expect(s.tools.list().length).toBe(allTools().length);
    // IOS-5 services are composed (stubs until each stream lands).
    for (const k of ['radar', 'world', 'prompts', 'formatPlans'] as const) expect(s[k]).toBeTruthy();
    await db.close();
  });
});
