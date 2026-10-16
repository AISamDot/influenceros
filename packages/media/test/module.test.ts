import { MEDIA_RENDER_JOB } from '@ios/agents';
import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@ios/media module', () => {
  it('exports a StudioModule within its namespaces', () => {
    expect(mod.tools.map((t) => t.name).sort()).toEqual(['media.probe_costs', 'media.rerender', 'media.slot', 'media.status', 'voice.redesign']);
    // IOS-5 stream K: the production identity and location-lock jobs run here (they buy stills).
    expect(Object.keys(mod.jobs).sort()).toEqual(['look.build', 'media.cost_probe', 'media.prepare_persona', 'production.lock_locations', MEDIA_RENDER_JOB].sort());
    for (const s of mod.schedules) expect(s.name).toMatch(/^(?:media|production)\./);
    expect(mod.liveProviders({ isLive: () => true, secret: () => 'x' })).toEqual({}); // never live under Vitest
  });
});
