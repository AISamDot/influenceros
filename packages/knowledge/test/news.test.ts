import { makeTestPersona } from '@troupe/agents/testing';
import { json } from '@troupe/db';
import type { FeedItem } from '@troupe/providers';
import { describe, expect, it } from 'vitest';
import {
  buildBriefing,
  canonicalUrl,
  fakeBriefingDraft,
  NEWS_JOBS,
  parseBriefingDraft,
  sameStory,
  scanNiche,
  scoreItem,
  titleKey,
} from '../src';
import { drain, hoursAgo, knowledgeStudio, NOW, providersWithFeeds } from './helpers';

const item = (title: string, url: string, h: number, summary = ''): FeedItem => ({ title, url, publishedAt: hoursAgo(h), summary: summary || title, source: new URL(url).hostname });

const STORIES: Record<string, FeedItem[]> = {
  'www.globaldatinginsights.com': [
    item('Dating app paying users fall again as singles return to in-person events', 'https://www.globaldatinginsights.com/a/paying-users-fall?utm_source=rss', 3, 'Dating app payers declined for a ninth quarter; singles move to in-person dating events and run clubs.'),
    item('Romance scam losses hit record as FTC warns older daters', 'https://www.globaldatinginsights.com/a/romance-scams', 5, 'Romance scam losses reported to the FTC rose again; older adults dating online are targeted.'),
    item('Ten-year-old interview resurfaces', 'https://www.globaldatinginsights.com/a/old', 24 * 12),
  ],
  'news.google.com': [
    item('Dating app paying users fall again as singles return to in-person events - The Verge', 'https://news.google.com/rss/articles/abc123', 4, 'Dating app payers declined; singles return to in-person dating.'),
    item('Situationship survey: Gen Z daters want clear intentions', 'https://news.google.com/rss/articles/def456', 7, 'A survey of dating Gen Z singles finds most want clarity and emotional honesty in dating.'),
  ],
  'www.reddit.com': [item('He texted "hey stranger" after three weeks, what do I say?', 'https://www.reddit.com/r/dating_advice/comments/x1/', 2, 'Dating advice thread about texting after silence.')],
};

async function datingStudio() {
  const t = await knowledgeStudio({ providers: providersWithFeeds(STORIES) });
  const rosa = await makeTestPersona(t, { name: 'Rosa Bellini', niche: 'dating', timezone: 'America/New_York' });
  const other = await makeTestPersona(t, { name: 'Other Persona', niche: 'personal finance' });
  await t.db.query(
    `INSERT INTO persona_bible (persona_id, version, content, status, created_by) VALUES ($1, 1, $2::jsonb, 'approved', 'agent:studio-manager')`,
    [rosa.id, json({ news_beats: { topics: ['dating apps', 'romance scams', 'situationships'], never_comment_on: ['specific politicians'] } })],
  );
  await t.db.query('UPDATE persona SET current_bible_version = 1 WHERE id = $1', [rosa.id]);
  for (const [name, url] of [
    ['Feed: Global Dating Insights', 'https://www.globaldatinginsights.com/feed/'],
    ['Feed: Google News dating', 'https://news.google.com/rss/search?q=dating'],
    ['Feed: r/dating_advice', 'https://www.reddit.com/r/dating_advice/.rss'],
    ['Feed: broken', 'https://down.example.com/rss'],
  ]) {
    await t.db.query(
      `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, meta) VALUES ($1, 'dating', $2, $3, 'rss', true, 4, '{"origin":"seed","feed":true}')`,
      [t.studioId, name, url],
    );
  }
  return { t, rosa, other };
}

describe('News Desk: pure helpers', () => {
  it('canonicalises URLs and recognises the same story across outlets', () => {
    expect(canonicalUrl('https://WWW.Example.com/a/b/?utm_source=x&id=2&fbclid=y#top')).toBe('https://example.com/a/b?id=2');
    const a = titleKey('Dating app paying users fall again as singles return to in-person events');
    const b = titleKey('Dating app paying users fall again as singles return to in-person events - The Verge');
    expect(a).toBe(b);
    expect(sameStory(a, titleKey('Paying users of dating apps fall again; singles return to in-person events'))).toBe(true);
    expect(sameStory(a, titleKey('Romance scam losses hit record as FTC warns older daters'))).toBe(false);
  });

  it('scores fresh, credible, relevant, widely covered stories highest', () => {
    const base = { now: NOW, credibility: 4, relevance: 0.5, coverage: 1, kind: 'news' as const };
    const fresh = scoreItem({ ...base, publishedAt: hoursAgo(2) });
    const stale = scoreItem({ ...base, publishedAt: hoursAgo(60) });
    const covered = scoreItem({ ...base, publishedAt: hoursAgo(2), coverage: 3 });
    const reddit = scoreItem({ ...base, publishedAt: hoursAgo(2), kind: 'reddit' });
    expect(fresh).toBeGreaterThan(stale);
    expect(covered).toBeGreaterThan(fresh);
    expect(reddit).toBeLessThan(fresh);
    expect(scoreItem({ ...base, publishedAt: hoursAgo(1), credibility: 5, relevance: 1, coverage: 9 })).toBeLessThanOrEqual(100);
  });

  it('keeps only draft entries about the candidate stories', () => {
    const d = parseBriefingDraft(
      {
        items: [
          { news_item_id: 'a', why_it_matters: 'Because.', take: 'Opinion.' },
          { news_item_id: 'invented', why_it_matters: 'x', take: 'y' },
        ],
        reaction_ideas: [{ news_item_id: 'invented', title: 't', angle: 'a', hook: 'h' }],
      },
      ['a'],
    );
    expect(d.items.map((i) => i.news_item_id)).toEqual(['a']);
    expect(d.reaction_ideas).toEqual([]);
    expect(() => parseBriefingDraft({ items: 'nope' }, [])).toThrow();
  });
});

describe('News Desk: scan → briefing → reaction queue (FakeFeeds)', () => {
  it('dedupes, scores, writes the morning briefing, posts it to the persona chat and queues reaction ideas', async () => {
    const { t, rosa, other } = await datingStudio();
    const scan = await scanNiche(t.services, { studioId: t.studioId, niche: 'Dating' });
    expect(scan).toMatchObject({ niche: 'dating', feeds: 4, failedFeeds: 1, fetched: 6, inserted: 4, duplicates: 1, briefingsQueued: 1 });

    const items = await t.db.query<{ title: string; url: string; score: number; coverage: number; duplicate_of: string | null; kind: string; embedding_model: string | null }>(
      `SELECT title, url, score, coverage, duplicate_of, kind, embedding_model FROM news_item WHERE studio_id = $1 ORDER BY score DESC NULLS LAST`,
      [t.studioId],
    );
    expect(items).toHaveLength(5); // the 12-day-old item is skipped
    const original = items.find((i) => i.url === 'https://globaldatinginsights.com/a/paying-users-fall')!;
    expect(original.coverage).toBe(2);
    expect(items.filter((i) => i.duplicate_of)).toHaveLength(1);
    expect(items.find((i) => i.kind === 'reddit')).toBeDefined();
    expect(items.filter((i) => !i.duplicate_of).every((i) => i.score > 0 && i.embedding_model === 'fake-embeddings')).toBe(true);
    const broken = await t.db.one<{ fetch_failures: number; last_error: string }>(`SELECT fetch_failures, last_error FROM knowledge_source WHERE name = 'Feed: broken'`);
    expect(broken).toMatchObject({ fetch_failures: 1, last_error: 'upstream 503' });

    // Re-scanning the same feeds adds nothing new.
    expect(await scanNiche(t.services, { studioId: t.studioId, niche: 'dating', queueBriefings: false })).toMatchObject({ inserted: 0, duplicates: 0 });

    const ran = await drain(t.services);
    expect(ran).toEqual([{ kind: NEWS_JOBS.briefing, outcome: 'succeeded' }]);

    const briefing = await t.services.knowledge.latestBriefing(rosa.id);
    expect(briefing).not.toBeNull();
    expect(briefing!.date).toBe('2026-10-14');
    expect(briefing!.items.length).toBeGreaterThanOrEqual(3);
    expect(briefing!.items.every((i) => i.whyItMatters && i.take && i.url && i.score >= 30)).toBe(true);
    expect(briefing!.items[0]!.score).toBeGreaterThanOrEqual(briefing!.items.at(-1)!.score);
    expect(briefing!.reactionIdeas.length).toBeGreaterThan(0);
    for (const r of briefing!.reactionIdeas) {
      expect(r.expiresAt.getTime() - NOW.getTime()).toBe(48 * 3_600_000);
      expect(briefing!.items.some((i) => i.newsItemId === r.newsItemId)).toBe(true);
    }
    expect(await t.services.knowledge.latestBriefing(other.id)).toBeNull();

    const ideas = await t.db.query<{ title: string; purpose: string; source: { type: string; news_item_id: string; briefing_date: string; expires_at: string } }>(
      `SELECT title, purpose, source FROM idea WHERE persona_id = $1`,
      [rosa.id],
    );
    expect(ideas).toHaveLength(briefing!.reactionIdeas.length);
    expect(ideas[0]!.source).toMatchObject({ type: 'news', briefing_date: '2026-10-14' });
    expect(ideas[0]!.purpose).toBe('reach');

    const msg = await t.db.one<{ author: string; role: string; body: string; meta: Record<string, unknown> }>(
      `SELECT m.author, m.role, m.body, m.meta FROM chat_message m JOIN chat_thread th ON th.id = m.thread_id WHERE th.persona_id = $1`,
      [rosa.id],
    );
    expect(msg).toMatchObject({ author: 'agent:news-desk', role: 'agent' });
    expect(msg.meta).toMatchObject({ kind: 'briefing', fake: true, briefingDate: '2026-10-14' });
    expect(msg.meta.runId).toEqual(expect.any(String));
    expect(msg.body).toContain('Morning briefing · 2026-10-14');

    const run = await t.db.one<{ agent: string; persona_id: string }>(`SELECT agent, persona_id FROM agent_run WHERE agent = 'news-desk'`);
    expect(run.persona_id).toBe(rosa.id);
    const debit = await t.db.one<{ ref_type: string }>(`SELECT ref_type FROM credit_ledger WHERE persona_id = $1 AND entry_type = 'debit'`, [rosa.id]);
    expect(debit.ref_type).toBe('news');

    // News is retrievable as evidence too.
    const hits = await t.services.knowledge.retrieve({ studioId: t.studioId, niche: 'dating', query: 'romance scam losses older daters', kinds: ['news'], k: 2 });
    expect(hits[0]).toMatchObject({ kind: 'news', title: 'Romance scam losses hit record as FTC warns older daters' });
    expect(hits[0]!.citations[0]!.url).toBe('https://globaldatinginsights.com/a/romance-scams');
  });

  it('is idempotent per persona and day, and skips stories already briefed', async () => {
    const { t, rosa } = await datingStudio();
    await scanNiche(t.services, { studioId: t.studioId, niche: 'dating', queueBriefings: false });
    const first = await buildBriefing(t.services, { personaId: rosa.id });
    const again = await buildBriefing(t.services, { personaId: rosa.id });
    expect(first!.created).toBe(true);
    expect(again!.created).toBe(false);
    expect(again!.briefing.items).toEqual(first!.briefing.items);
    const tomorrow = await buildBriefing(t.services, { personaId: rosa.id, date: '2026-10-15' });
    expect(tomorrow!.briefing.items).toEqual([]); // nothing new since yesterday's briefing
    expect(await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM chat_message`)).toEqual({ n: 1 });
    const ideas = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM idea WHERE persona_id = $1`, [rosa.id]);
    await buildBriefing(t.services, { personaId: rosa.id, force: true });
    expect(await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM idea WHERE persona_id = $1`, [rosa.id])).toEqual(ideas);
  });

  it('gives a niche without feeds a Google News search feed', async () => {
    const t = await knowledgeStudio();
    await makeTestPersona(t, { niche: 'sleep' });
    await t.db.query(`UPDATE persona SET sub_niche = 'sleep routines, insomnia myths' WHERE niche = 'sleep'`);
    const s = await scanNiche(t.services, { studioId: t.studioId, niche: 'sleep', queueBriefings: false });
    expect(s.feeds).toBe(1);
    const feed = await t.db.one<{ url: string; meta: { origin: string } }>(`SELECT url, meta FROM knowledge_source WHERE kind = 'rss'`);
    expect(feed.url).toMatch(/^https:\/\/news\.google\.com\/rss\/search\?q=%22sleep%20routines%22%20OR%20%22insomnia%20myths%22/);
    expect(feed.meta.origin).toBe('default');
  });

  it('writes a deterministic fake draft that never invents stories', () => {
    const d = fakeBriefingDraft({ name: 'Rosa Bellini', niche: 'dating' }, [
      { id: 'n1', title: 'Story', url: 'https://x.test/1', summary: null, score: 70, source: 'X', kind: 'news' },
      { id: 'n2', title: 'Thread', url: 'https://reddit.com/r/x', summary: null, score: 80, source: 'reddit', kind: 'reddit' },
    ]);
    expect(d.items.map((i) => i.news_item_id)).toEqual(['n1', 'n2']);
    expect(d.reaction_ideas.map((r) => r.news_item_id)).toEqual(['n1']); // Reddit is audience signal, not news
    expect(d.items[0]!.take).toMatch(/^Rosa's take/);
  });
});
