import { personaSiteUrl, SITE_PATHS, type StudioServices } from '@troupe/agents';
import { loadPersonaContext, type ProductBrief } from '@troupe/content';
import { type Block, type DocSection, type ProductDoc, sectionIds, type SectionKind } from './model';

/**
 * Brief → structured content (the product-builder agent, strong tier, workbook-builder skill). In fake mode (no
 * Anthropic key, every test) a deterministic writer builds the same shape from the brief, so the whole pipeline runs
 * end to end without keys.
 */

const BLOCK_TYPES = ['paragraph', 'subheading', 'list', 'numbered_list', 'rule', 'checklist', 'tracker', 'fill_in', 'example', 'callout', 'table'] as const;
const KINDS: readonly SectionKind[] = ['intro', 'core', 'tools', 'bonus', 'next'];

export const DOC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'subtitle', 'sections'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind', 'blocks'],
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: [...KINDS] },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'title', 'text', 'items', 'columns', 'lines'],
              properties: {
                type: { type: 'string', enum: [...BLOCK_TYPES] },
                title: { type: 'string' },
                text: { type: 'string' },
                items: { type: 'array', items: { type: 'string' } },
                columns: { type: 'array', items: { type: 'string' } },
                lines: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
} as const;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function toBlock(raw: unknown): Block | null {
  const b = rec(raw);
  const title = str(b.title);
  const text = str(b.text);
  const items = strs(b.items).slice(0, 40);
  switch (b.type) {
    case 'paragraph':
      return text ? { t: 'p', text } : null;
    case 'subheading':
      return text || title ? { t: 'h', text: text || title } : null;
    case 'list':
    case 'numbered_list':
      return items.length ? { t: 'list', ordered: b.type === 'numbered_list', items } : null;
    case 'rule':
      return title && text ? { t: 'rule', name: title, text } : null;
    case 'checklist':
      return items.length ? { t: 'checklist', ...(title ? { title } : {}), items } : null;
    case 'tracker': {
      const columns = strs(b.columns).slice(0, 14);
      return items.length ? { t: 'tracker', title: title || 'Tracker', rows: items, columns: columns.length ? columns : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } : null;
    }
    case 'fill_in':
      return text || title ? { t: 'fillin', prompt: text || title, lines: Math.min(20, Math.max(1, Math.round(Number(b.lines) || 4))) } : null;
    case 'example':
      return text ? { t: 'example', title: title || 'Worked example', text } : null;
    case 'callout':
      return text ? { t: 'callout', text } : null;
    case 'table': {
      const header = strs(b.columns);
      const rows = items.map((r) => r.split('|').map((c) => c.trim()));
      return header.length ? { t: 'table', header, rows } : null;
    }
    default:
      return null;
  }
}

/** Validates the model's structured content. */
export function parseDoc(v: unknown, personaName: string, promised: readonly string[]): ProductDoc {
  const r = rec(v);
  const title = str(r.title);
  const raw = Array.isArray(r.sections) ? r.sections.map(rec) : [];
  const sections = raw
    .map((s) => ({ title: str(s.title), kind: (KINDS.includes(s.kind as SectionKind) ? s.kind : 'core') as SectionKind, blocks: (Array.isArray(s.blocks) ? s.blocks : []).map(toBlock).filter((b): b is Block => !!b) }))
    .filter((s) => s.title && s.blocks.length);
  if (!title || sections.length < 3) throw new Error('a product needs a title and at least 3 sections with content');
  const ids = sectionIds(sections.map((s) => s.title));
  return { title: title.slice(0, 120), subtitle: str(r.subtitle).slice(0, 300), personaName, promised, sections: sections.map((s, i) => ({ ...s, id: ids[i]! })) };
}

/** A ProductDoc in the model's JSON shape (DOC_SCHEMA): what the fake writer returns, so `parse` checks it too. */
export function docToModelJson(doc: ProductDoc): Record<string, unknown> {
  const blank = { title: '', text: '', items: [] as string[], columns: [] as string[], lines: 0 };
  const block = (b: Block): Record<string, unknown> | null => {
    switch (b.t) {
      case 'p':
        return { ...blank, type: 'paragraph', text: b.text };
      case 'h':
        return { ...blank, type: 'subheading', text: b.text };
      case 'list':
        return { ...blank, type: b.ordered ? 'numbered_list' : 'list', items: [...b.items] };
      case 'rule':
        return { ...blank, type: 'rule', title: b.name, text: b.text };
      case 'checklist':
        return { ...blank, type: 'checklist', title: b.title ?? '', items: [...b.items] };
      case 'tracker':
        return { ...blank, type: 'tracker', title: b.title, items: [...b.rows], columns: [...b.columns] };
      case 'fillin':
        return { ...blank, type: 'fill_in', text: b.prompt, lines: b.lines };
      case 'example':
        return { ...blank, type: 'example', title: b.title, text: b.text };
      case 'callout':
        return { ...blank, type: 'callout', text: b.text };
      case 'table':
        return { ...blank, type: 'table', columns: [...b.header], items: b.rows.map((r) => r.join(' | ')) };
      case 'pagebreak':
        return null;
    }
  };
  return {
    title: doc.title,
    subtitle: doc.subtitle,
    sections: doc.sections.map((s) => ({ title: s.title, kind: s.kind === 'credits' ? 'next' : s.kind, blocks: s.blocks.map(block).filter(Boolean) })),
  };
}

/** Sections the brief promises: its outline, then one page per bonus. */
export function promisedFromBrief(brief: ProductBrief): string[] {
  return [...brief.outline, ...brief.bonuses.map((b) => `Bonus: ${b}`)];
}

const clean = (s: string) =>
  s
    .replace(/\s*\(.*?\)/g, '')
    .replace(/^(part|step)\s+\d+\s*[:.\-–—]\s*/i, '')
    .trim();
/** "the setup" → "setup", so "The … rule" never reads "The the …". */
const bare = (s: string) => s.replace(/^(?:the|a|an|your)\s+/i, '');
const lc = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** The deterministic writer (fake mode): every outline item becomes a full section, every bonus a bonus page. */
export function fakeDoc(brief: ProductBrief, personaName: string, frameworkSteps: readonly string[] = []): ProductDoc {
  const parts = brief.outline.filter((o) => !/start here|worked example|summary/i.test(o));
  const sections: Array<Omit<DocSection, 'id'>> = [];
  for (const item of brief.outline) {
    if (/start here/i.test(item)) {
      sections.push({
        title: item,
        kind: 'intro',
        blocks: [
          { t: 'p', text: `**Who it's for:** ${brief.audience.replace(/\.$/, '')}.` },
          { t: 'p', text: `**Who it's not for:** anyone who needs personal professional advice. This is a set of steps, words and pages to use, not a promised outcome.` },
          { t: 'list', ordered: true, items: ['Read the rule at the top of each part (two minutes).', 'Look at the worked example.', 'Fill in your page and tick the checklist as you go.'] },
          { t: 'callout', text: brief.promise },
        ],
      });
    } else if (/worked example/i.test(item)) {
      sections.push({
        title: item,
        kind: 'core',
        blocks: [
          { t: 'p', text: `Here is one week run with the ${parts.length}-part system, start to finish, so you can see how the pages fit together.` },
          ...parts.slice(0, 3).map((p, i): Block => ({ t: 'example', title: `Day ${i * 2 + 1}: ${clean(p)}`, text: `The page took ten minutes. The first pass was rough and that was fine: the checklist caught the one step that was skipped, and it was done the next morning.` })),
          { t: 'fillin', prompt: 'Your version: what will your first week look like?', lines: 5 },
        ],
      });
    } else if (/summary/i.test(item)) {
      sections.push({
        title: item,
        kind: 'tools',
        blocks: [
          { t: 'p', text: 'Everything on one page: print it and keep it where you will see it.' },
          { t: 'checklist', title: 'The short version', items: parts.map((p) => clean(p)) },
          { t: 'tracker', title: 'Weekly tracker', rows: parts.map((p) => clean(p)), columns: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
        ],
      });
    } else {
      const name = clean(item);
      const step = frameworkSteps.find((s) => item.includes(clean(s))) ?? name;
      sections.push({
        title: item,
        kind: 'core',
        blocks: [
          { t: 'p', text: `${name} is the part most people skip, so it gets its own page. Read the rule, then do the page: it takes about ten minutes.` },
          { t: 'rule', name: `The ${bare(lc(clean(step))).split(' ').slice(0, 3).join(' ')} rule`, text: `Do the smallest version today, write it down, and check it once a week. Small and written beats big and remembered.` },
          { t: 'example', title: 'Worked example', text: `Monday: ten minutes on ${lc(name)}. Two items written down, one done on the spot, one booked for Thursday. Sunday: a two-minute check and a tick on the tracker.` },
          { t: 'fillin', prompt: `Your ${bare(lc(name))}: what is the smallest version you can do this week?`, lines: 4 },
          { t: 'checklist', items: [`Read the ${bare(lc(name))} rule`, 'Filled in my page', 'Booked a time for the weekly check'] },
        ],
      });
    }
  }
  for (const b of brief.bonuses) {
    sections.push({
      title: `Bonus: ${b}`,
      kind: 'bonus',
      blocks: [
        { t: 'p', text: `A printable extra to go with the main pages.` },
        { t: 'checklist', title: b, items: ['Print or duplicate this page', 'Fill in the first row today', 'Keep it next to your tracker'] },
        { t: 'fillin', prompt: 'Notes', lines: 6 },
      ],
    });
  }
  const ids = sectionIds(sections.map((s) => s.title));
  return {
    title: brief.name,
    subtitle: brief.promise,
    personaName,
    promised: promisedFromBrief(brief),
    sections: sections.map((s, i) => ({ ...s, id: ids[i]! })),
  };
}

// ───────────────────────────── Next step + credits (every product) ─────────────────────────────

/** The niche's referral line (workbook-builder skill: credits page). */
export function referralFor(niche: string): string {
  const n = niche.toLowerCase();
  if (/health|food|diet|nutrition|fitness|meal|cook|weight|sleep|wellness/.test(n)) return 'For health or diet questions, talk to a doctor or a registered dietitian.';
  if (/money|financ|budget|debt|saving|invest|tax|frugal/.test(n)) return 'For money decisions, talk to a licensed financial adviser or the relevant government service.';
  if (/legal|law|tenant|divorce|contract/.test(n)) return 'For legal questions, talk to a lawyer.';
  if (/relationship|dating|breakup|family|parent|mental|anxiety|grief/.test(n)) return 'If your safety is at risk, contact local emergency services or a crisis or abuse hotline.';
  return 'For anything specific to your situation, talk to a qualified professional.';
}

export const AI_CREDIT_LINE = (persona: string) => `Created by an AI character from the Troupe House studio. ${persona} is fictional; the stories are entertainment.`;
export const ADVICE_LINE = 'General education, not professional advice.';

/** Appends the next-step page (when missing) and makes sure the credits page carries the required lines. */
export function withNextStepAndCredits(
  doc: ProductDoc,
  args: { personaName: string; personaSlug: string; niche: string; nextStep?: string; sources?: ReadonlyArray<{ title: string; url: string }> },
): ProductDoc {
  const sections = [...doc.sections];
  const site = personaSiteUrl(args.personaSlug, SITE_PATHS.home);
  if (!sections.some((s) => s.kind === 'next')) {
    sections.push({
      id: '',
      title: 'Next step',
      kind: 'next',
      blocks: [{ t: 'p', text: `${args.nextStep ? `When you're ready: ${args.nextStep}.` : 'When this is running, the next tool in the set picks up where it ends.'} Everything ${args.personaName} makes is at [${site.replace(/^https?:\/\//, '')}](${site}).` }],
    });
  }
  const required: Block[] = [
    { t: 'p', text: AI_CREDIT_LINE(args.personaName) },
    { t: 'p', text: `**${ADVICE_LINE}** ${referralFor(args.niche)}` },
    ...(args.sources?.length ? [{ t: 'list' as const, ordered: false, items: args.sources.map((s) => `[${s.title.replace(/[[\]]/g, '')}](${s.url})`) }] : []),
    { t: 'p', text: `© ${new Date().getUTCFullYear()} ${args.personaName}. For your own personal use; please don't resell or share the file.` },
  ];
  const ci = sections.findIndex((s) => s.kind === 'credits');
  if (ci >= 0) {
    const existing = sections[ci]!;
    const text = existing.blocks.map((b) => JSON.stringify(b)).join(' ');
    const missing = required.filter((b) => !(b.t === 'p' && (b.text.includes('AI character') ? /AI character/i.test(text) : b.text.includes(ADVICE_LINE) ? text.includes(ADVICE_LINE) : false)));
    sections[ci] = { ...existing, blocks: [...existing.blocks, ...missing] };
    sections.push(sections.splice(ci, 1)[0]!); // credits last
  } else {
    sections.push({ id: '', title: 'Credits and notes', kind: 'credits', blocks: required });
  }
  const ids = sectionIds(sections.map((s) => s.title));
  return { ...doc, personaName: args.personaName, sections: sections.map((s, i) => ({ ...s, id: ids[i]! })) };
}

// ───────────────────────────── The agent run ─────────────────────────────

/** Writes the product's content from its brief through the runtime (cost ref: product). */
export async function writeFromBrief(
  services: StudioServices,
  args: { personaId: string; productId: string; brief: ProductBrief; feedback?: readonly string[] },
): Promise<{ doc: ProductDoc; runId: string }> {
  const ctx = await loadPersonaContext(services.db, args.personaId);
  const promised = promisedFromBrief(args.brief);
  const steps = ctx.frameworks[0]?.steps ?? [];
  const res = await services.runtime.run<ProductDoc>({
    agent: 'product-builder',
    scope: { studioId: ctx.persona.studio_id, personaId: ctx.persona.id },
    label: `product content: ${args.brief.ladder_rung}${args.feedback?.length ? ' (fix)' : ''}`,
    system: `You are the Product Builder. Write the full content of a small digital product from the brief, in the persona's voice, English only.
Use the workbook-builder skill: "Start here", the persona's named framework as numbered sections (each with a short explanation, a named rule,
a worked example, a fill-in page and a checklist), tools (tick-box trackers, templates), one bonus page per promised bonus, and a next step.
Use exactly the brief's outline items as section titles, in order, then "Bonus: <bonus>" sections. Never write placeholder text (no TODO,
lorem ipsum, [insert …]). It sells words to say, steps to take or a system to run, never an outcome: no guaranteed results or income,
no disease-cure or treatment claims, no securities picks, no fake scarcity, no testimonials. Leave out the credits page: it is added for you.`,
    cached: ctx.cached,
    skills: ['workbook-builder'],
    prompt: `Brief:\n${JSON.stringify(args.brief)}${steps.length ? `\nThe persona's framework: ${steps.join(' → ')}` : ''}${
      args.feedback?.length ? `\nThe last draft failed product QC. Fix exactly these and keep everything else:\n- ${args.feedback.join('\n- ')}` : ''
    }`,
    maxTokens: 16000,
    jsonSchema: DOC_SCHEMA,
    parse: (v) => parseDoc(v, ctx.persona.name, promised),
    fake: () => docToModelJson(fakeDoc(args.brief, ctx.persona.name, steps)) as unknown as ProductDoc,
    costRef: { type: 'product', id: args.productId },
  });
  return { doc: res.output, runId: res.runId };
}
