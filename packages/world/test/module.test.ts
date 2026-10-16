import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@ios/world module', () => {
  it('exports a StudioModule and its service factory', () => {
    expect(Array.isArray(mod.tools)).toBe(true);
    expect(typeof mod.jobs).toBe('object');
    expect(Array.isArray(mod.schedules)).toBe(true);
    expect(typeof mod.liveProviders).toBe('function');
    expect(typeof mod.createWorldService).toBe('function');
  });
});
