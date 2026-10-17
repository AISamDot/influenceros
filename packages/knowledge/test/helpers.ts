import type { StudioServices } from '@troupe/agents';
import { createTestStudio, type TestStudio } from '@troupe/agents/testing';
import { type JobHandler, runOnce } from '@troupe/core';
import { createFakeProviders, type FakeProviders, FakeFeeds, type FeedItem } from '@troupe/providers';
import { createKnowledgeService, jobs } from '../src';

/** A Wednesday morning, a few hours after FakeFeeds' default timestamps. */
export const NOW = new Date('2026-10-14T09:00:00Z');

/** A test studio with stream C's KnowledgeService, fake providers and a fixed clock. */
export async function knowledgeStudio(opts: { providers?: FakeProviders; now?: Date } = {}): Promise<TestStudio> {
  const now = opts.now ?? NOW;
  return createTestStudio({ providers: opts.providers, knowledge: createKnowledgeService, now: () => now });
}

/**
 * Runs queued jobs of our kinds until none is left (or `max` jobs ran). Jobs are stamped with the database clock,
 * so claims use the real clock (a minute ahead), not the services' fixed test clock.
 */
export async function drain(services: StudioServices, max = 500, now = new Date(Date.now() + 60_000)): Promise<Array<{ kind: string; outcome: string }>> {
  const handlers: Record<string, JobHandler> = Object.fromEntries(
    Object.entries(jobs).map(([kind, h]) => [kind, (job) => h({ services, job, heartbeat: async () => true })]),
  );
  const done: Array<{ kind: string; outcome: string }> = [];
  for (let i = 0; i < max; i++) {
    const r = await runOnce(services.db, handlers, { workerId: 'test', now, maxRunningPerPersona: 5 });
    if (!r) break;
    done.push({ kind: r.job.kind, outcome: r.outcome });
  }
  return done;
}

/** Feeds that publish niche-relevant stories, with the same story on two outlets (dedupe) and an old item. */
export class StoryFeeds extends FakeFeeds {
  constructor(private readonly stories: Record<string, FeedItem[]>) {
    super();
  }
  override async fetchFeed(req: { url: string; limit?: number }): Promise<FeedItem[]> {
    await super.fetchFeed(req); // records the call
    const host = new URL(req.url).hostname;
    if (host === 'down.example.com') throw new Error('upstream 503');
    return (this.stories[host] ?? []).slice(0, req.limit ?? 25);
  }
}

export function providersWithFeeds(stories: Record<string, FeedItem[]>): FakeProviders {
  const base = createFakeProviders();
  return { ...base, feeds: new StoryFeeds(stories) } as FakeProviders;
}

export const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3_600_000);
