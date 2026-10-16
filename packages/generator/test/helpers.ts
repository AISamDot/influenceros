import { createTestStudio, type TestStudio } from '@ios/agents/testing';
import { GENERATOR_TOOLS } from '../src';

/** A Thursday in October 2026, after the archive decision. */
export const NOW = new Date('2026-10-16T09:00:00Z');

/** A test studio whose registry holds the generator.* tools (plus nothing else), fake providers, a fixed clock. */
export async function generatorStudio(): Promise<TestStudio> {
  return createTestStudio({ tools: GENERATOR_TOOLS, now: () => NOW });
}
