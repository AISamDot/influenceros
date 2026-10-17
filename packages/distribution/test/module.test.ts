import { PUBLISH_PREPARE_JOB } from '@troupe/agents';
import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@troupe/distribution module', () => {
  it('exports a StudioModule inside stream F namespaces', () => {
    const ns = /^(?:publish|community|analytics|accounts)\./;
    expect(mod.tools.length).toBeGreaterThan(0);
    for (const t of mod.tools) expect(t.name).toMatch(ns);
    for (const k of Object.keys(mod.jobs)) expect(k).toMatch(ns);
    for (const s of mod.schedules) expect(s.name).toMatch(ns);
    expect(Object.keys(mod.jobs)).toContain(PUBLISH_PREPARE_JOB);
    expect(Object.keys(mod.jobs).sort()).toEqual(['accounts.sync', 'analytics.pull', 'community.handle', 'community.poll', 'publish.post', 'publish.prepare']);
    expect(typeof mod.liveProviders).toBe('function');
  });

  it('mutating tools need the Owner to ask in untrusted runs, and none of them acts on accounts or approvals', () => {
    for (const t of mod.tools.filter((x) => x.mutates)) expect(t.ownerIntent).toBeInstanceOf(RegExp);
    expect(mod.tools.find((t) => t.name === 'community.queue')!.untrustedOutput).toBe(true);
    expect(mod.tools.some((t) => /approve|create_account|crisis/.test(t.name))).toBe(false);
  });
});
