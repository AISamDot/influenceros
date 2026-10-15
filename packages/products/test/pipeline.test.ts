import { describe, expect, it } from 'vitest';
import {
  fakeDoc,
  FakePdfRenderer,
  inline,
  inspectPdf,
  layoutDoc,
  parseManuscript,
  type PageSize,
  type ProductDoc,
  renderHtml,
  runQp,
  templateSpec,
  titleMatches,
  withNextStepAndCredits,
} from '../src';
import { BRIEF, KIT, MANUSCRIPT } from './fixtures';

async function renderBoth(doc: ProductDoc, renderer = new FakePdfRenderer()) {
  const out = [];
  for (const size of ['A4', 'Letter'] as PageSize[]) {
    const layout = layoutDoc(doc, size);
    const html = renderHtml(doc, layout, KIT);
    const r = await renderer.render({ html, layout, title: doc.title });
    out.push({ size, layout, html, pdf: inspectPdf(r.pdf), overflowPages: r.overflowPages });
  }
  return out;
}

const finished = (doc: ProductDoc) => withNextStepAndCredits(doc, { personaName: 'Dot', personaSlug: 'dot', niche: 'home organisation', nextStep: 'the Monthly Reset bundle' });

describe('manuscript import', () => {
  it('parses front matter, sections, named rules, trackers, fill-ins, tick boxes, bonus pages and tables', () => {
    const { meta, doc } = parseManuscript(MANUSCRIPT, { personaName: 'Dot' });
    expect(meta).toMatchObject({ title: 'The Calm Budget Workbook', slug: 'calm-budget', rung: 'entry', priceCents: 1700, templates: ['sheet', 'notion'] });
    expect(doc.title).toBe('The Calm Budget Workbook');
    expect(doc.subtitle).toBe('Give every dollar a job in one evening');
    expect(doc.promised).toEqual(['Start here', 'The three buckets', 'Weekly money check', 'Bonus: Bill calendar']);
    expect(doc.sections.map((s) => [s.title, s.kind])).toEqual([
      ['Start here', 'intro'],
      ['The three buckets', 'core'],
      ['Weekly money check', 'core'],
      ['Bonus: Bill calendar', 'bonus'],
    ]);
    const buckets = doc.sections[1]!.blocks;
    expect(buckets.map((b) => b.t)).toEqual(['rule', 'example', 'fillin', 'checklist']);
    expect(buckets[0]).toMatchObject({ t: 'rule', name: 'Bills before fun' });
    expect(buckets[2]).toMatchObject({ t: 'fillin', lines: 5 });
    expect(doc.sections[2]!.blocks[0]).toMatchObject({ t: 'tracker', title: 'Weekly check', rows: ['Checked balance', 'Logged spending', 'Moved savings'], columns: ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4'] });
    expect(doc.sections[3]!.blocks[0]).toMatchObject({ t: 'table', header: ['Bill', 'Due', 'Amount'] });
  });

  it('refuses a manuscript without sections', () => {
    expect(() => parseManuscript('# Just a title\n\nNo sections here.')).toThrow(/at least one "## Section"/);
  });

  it('turns a tick-box table into a tracker', () => {
    const { doc } = parseManuscript('# T\n\n## Habits\n\n| Habit | Mon | Tue |\n|---|---|---|\n| Walk | [ ] | [ ] |\n| Read | [ ] | [ ] |\n');
    expect(doc.sections[0]!.blocks[0]).toEqual({ t: 'tracker', title: 'Habit', rows: ['Walk', 'Read'], columns: ['Mon', 'Tue'] });
  });
});

describe('layout, HTML and PDF', () => {
  it('paginates with a TOC whose page numbers match where each section starts, for both paper sizes', () => {
    const doc = finished(fakeDoc(BRIEF, 'Dot'));
    for (const size of ['A4', 'Letter'] as PageSize[]) {
      const l = layoutDoc(doc, size);
      expect(l.pages[0]!.kind).toBe('cover');
      expect(l.pages[1]!.kind).toBe('toc');
      expect(l.pages.map((p) => p.number)).toEqual(l.pages.map((_, i) => i + 1));
      for (const e of l.toc) expect(l.pages.find((p) => p.sectionStart?.id === e.id)?.number).toBe(e.page);
      expect(l.toc.map((e) => e.title)).toEqual(doc.sections.map((s) => s.title));
    }
  });

  it('splits long lists over pages instead of overflowing', () => {
    const items = Array.from({ length: 120 }, (_, i) => `Item number ${i + 1} with a little explanation`);
    const doc: ProductDoc = { title: 'Long', subtitle: '', personaName: 'Dot', promised: [], sections: [{ id: 'sec-a', title: 'A', kind: 'core', blocks: [{ t: 'checklist', items }] }] };
    const l = layoutDoc(doc, 'A4');
    const pages = l.pages.filter((p) => p.sectionId === 'sec-a');
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flatMap((p) => p.blocks.flatMap((b) => (b.t === 'checklist' ? b.items : [])))).toEqual(items);
  });

  it('renders the persona kit, tick boxes, fill-in lines, footers with page numbers and safe links only', () => {
    const doc = finished(parseManuscript(MANUSCRIPT, { personaName: 'Dot' }).doc);
    const l = layoutDoc(doc, 'A4');
    const html = renderHtml(doc, l, KIT);
    expect(html).toContain('@page { size: A4');
    expect(html).toContain(KIT.accent);
    expect(html).toContain('class="box"');
    expect(html).toContain('class="line"');
    expect(html).toContain(`data-pn="${l.pages.length}"`);
    expect(html).toContain('<a href="https://www.consumerfinance.gov/">');
    expect(renderHtml(doc, layoutDoc(doc, 'Letter'), KIT)).toContain('@page { size: letter');
    const unsafe = inline('[x](javascript:alert(1)) **b** <script>');
    expect(unsafe).not.toContain('<a');
    expect(unsafe).not.toContain('<script');
    expect(unsafe).toContain('<strong>b</strong>');
  });

  it('the fake PDF is a real, inspectable PDF with the layout pages, size, embedded font and links', async () => {
    const doc = finished(parseManuscript(MANUSCRIPT, { personaName: 'Dot' }).doc);
    const [a4, letter] = await renderBoth(doc);
    expect(a4!.pdf).toMatchObject({ opens: true, pages: a4!.layout.pages.length });
    expect(a4!.pdf.mediaBox![0]).toBeCloseTo(595.28, 1);
    expect(letter!.pdf.mediaBox).toEqual([612, 792]);
    expect(a4!.pdf.fonts.every((f) => f.embedded)).toBe(true);
    expect(a4!.pdf.uris).toContain('https://www.consumerfinance.gov/');
    expect(a4!.pdf.internalLinks).toBe(a4!.layout.toc.length);
  });

  it('reads Chrome-style PDFs: Type0 fonts with embedded descendants, and flags standard fonts as unembedded', () => {
    const pdf = `%PDF-1.4
1 0 obj
<</Type /Catalog /Pages 2 0 R>>
endobj
2 0 obj
<</Type /Pages /Count 1 /Kids [3 0 R]>>
endobj
3 0 obj
<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [8 0 R]>>
endobj
4 0 obj
<</Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Georgia /DescendantFonts [5 0 R]>>
endobj
5 0 obj
<</Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Georgia /FontDescriptor 6 0 R>>
endobj
6 0 obj
<</Type /FontDescriptor /FontName /AAAAAA+Georgia /FontFile2 7 0 R>>
endobj
7 0 obj
<</Length 3>> stream
abc
endstream
endobj
8 0 obj
<</Type /Annot /Subtype /Link /A <</S /URI /URI (https://example.org/a\\(b\\))>>>>
endobj
9 0 obj
<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>
endobj
xref
0 10
trailer
<</Root 1 0 R>>
startxref
1
%%EOF
`;
    const r = inspectPdf(new TextEncoder().encode(pdf));
    expect(r).toMatchObject({ opens: true, pages: 1, mediaBox: [612, 792], uris: ['https://example.org/a(b)'] });
    expect(r.fonts).toEqual([
      { name: 'AAAAAA+Georgia', embedded: true },
      { name: 'Helvetica', embedded: false },
    ]);
    expect(inspectPdf(new TextEncoder().encode('<html></html>'))).toMatchObject({ opens: false });
  });
});

describe('QC QP', () => {
  it('passes a finished product', async () => {
    const doc = finished(fakeDoc(BRIEF, 'Dot'));
    const qp = await runQp({ doc, renders: await renderBoth(doc) });
    expect(qp.checks.filter((c) => !c.pass)).toEqual([]);
    expect(qp).toMatchObject({ pass: true, score: 100 });
    expect(qp.checks.map((c) => c.check)).toEqual(expect.arrayContaining(['pdf_opens', 'fonts_embedded', 'no_placeholder', 'toc', 'page_numbers', 'links', 'sections_present', 'credits_page', 'page_size', 'layout_overflow']));
  });

  it('catches placeholder text, missing promised sections, broken links and unembedded fonts', async () => {
    const base = finished(fakeDoc(BRIEF, 'Dot'));
    const bad: ProductDoc = {
      ...base,
      sections: base.sections
        .filter((s) => !/Part 2/.test(s.title))
        .map((s, i) => (i === 1 ? { ...s, blocks: [...s.blocks, { t: 'p', text: 'TODO: write the intro. Lorem ipsum. See [the guide](https://example.com/guide) and [x](not a url).' }] } : s)),
    };
    const qp = await runQp({ doc: bad, renders: await renderBoth(bad, new FakePdfRenderer({ embedFonts: false })) });
    const failed = Object.fromEntries(qp.checks.filter((c) => !c.pass).map((c) => [c.check, c]));
    expect(qp.pass).toBe(false);
    expect(failed.no_placeholder?.severity).toBe('blocker');
    expect(failed.no_placeholder?.message).toMatch(/TODO|lorem/i);
    expect(failed.sections_present?.message).toContain('Part 2: Plan the week');
    expect(failed.links?.message).toContain('https://example.com/guide');
    expect(failed.fonts_embedded?.message).toContain('Helvetica');
    expect(qp.contentFeedback.join(' ')).toMatch(/placeholder/);
  });

  it('catches a PDF that does not open, wrong page counts, dead TOC links and overflow', async () => {
    const doc = finished(fakeDoc(BRIEF, 'Dot'));
    const broken = await runQp({ doc, renders: await renderBoth(doc, new FakePdfRenderer({ corrupt: true })) });
    expect(broken.checks.find((c) => c.check === 'pdf_opens')).toMatchObject({ pass: false, severity: 'blocker' });
    const off = await runQp({ doc, renders: await renderBoth(doc, new FakePdfRenderer({ pageDelta: 1, dropLinks: true, overflowPages: [4] })) });
    const failed = off.checks.filter((c) => !c.pass).map((c) => c.check);
    expect(failed).toEqual(expect.arrayContaining(['page_count', 'toc', 'layout_overflow']));
    expect(off.overflow).toBe(true);
  });

  it('matches promised titles loosely (Part prefixes, wording) but not unrelated ones', () => {
    expect(titleMatches('Part 1: Clear the decks', 'Clear the decks')).toBe(true);
    expect(titleMatches('Bonus: Meal grid', 'Bonus: Meal grid')).toBe(true);
    expect(titleMatches('Weekly money check', 'Your weekly money check-in')).toBe(true);
    expect(titleMatches('Bill calendar', 'Grocery list')).toBe(false);
  });
});

describe('templates', () => {
  it('builds a Sheets/Notion spec from trackers, tables and checklists', () => {
    const spec = templateSpec(parseManuscript(MANUSCRIPT).doc);
    expect(spec.tabs.map((t) => t.name)).toEqual(['Weekly check', 'Bonus Bill calendar', 'Checklist']);
    expect(spec.tabs[0]).toMatchObject({ columns: ['Item', 'Wk 1', 'Wk 2', 'Wk 3', 'Wk 4'] });
    expect(spec.tabs[2]!.rows.some((r) => r[1] === 'Listed every fixed bill')).toBe(true);
  });
});

describe('live link checker', () => {
  it('passes reachable pages (incl. bot-blocking 403s), fails 404s and dead hosts, and skips the studio’s own sites', async () => {
    const { HttpLinkChecker } = await import('../src');
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      const u = String(url);
      if (u.includes('dead')) throw new TypeError('fetch failed');
      if (u.includes('missing')) return new Response(null, { status: 404 });
      if (u.includes('blocked')) return new Response(null, { status: 403 });
      if (u.includes('nohead') && init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const c = new HttpLinkChecker(['studio.sample.net'], fake);
    expect(await c.check('https://ok.org/a')).toBeNull();
    expect(await c.check('https://blocked.gov/a')).toBeNull();
    expect(await c.check('https://nohead.org/a')).toBeNull();
    expect(await c.check('https://missing.org/a')).toBe('HTTP 404');
    expect(await c.check('https://dead.org/a')).toMatch(/unreachable/);
    expect(await c.check('https://dot.studio.sample.net/free')).toBeNull();
    expect(calls.some((x) => x.includes('studio.sample.net'))).toBe(false);
  });
});
