import { MEDIA_RENDER_JOB } from '@ios/agents';
import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@ios/media module', () => {
  it('exports a StudioModule within its namespaces', () => {
    expect(mod.tools.map((t) => t.name).sort()).toEqual(['media.probe_costs', 'media.rerender', 'media.slot', 'media.status', 'voice.redesign']);
    expect(Object.keys(mod.jobs).sort()).toEqual(['media.cost_probe', 'media.prepare_persona', MEDIA_RENDER_JOB].sort());
    for (const s of mod.schedules) expect(s.name).toMatch(/^media\./);
    expect(mod.liveProviders({ isLive: () => true, secret: () => 'x' })).toEqual({}); // never live under Vitest
  });
});
