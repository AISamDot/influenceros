import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@troupe/products module', () => {
  it('exports a StudioModule', () => {
    expect(Array.isArray(mod.tools)).toBe(true);
    expect(typeof mod.jobs).toBe('object');
    expect(Array.isArray(mod.schedules)).toBe(true);
    expect(typeof mod.liveProviders).toBe('function');
  });
});
