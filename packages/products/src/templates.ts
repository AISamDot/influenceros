import { createHash } from 'node:crypto';
import type { MediaStore } from '@ios/providers';
import { blockStrings, plainInline, type ProductDoc } from './model';

/**
 * Google Sheets / Notion template option (FR-9.2) behind interfaces with fakes. A template is built from the
 * product's trackers, checklists and tables; buyers get a copy (Sheets `/copy`) or duplicate (Notion) link.
 * The fakes store a CSV / markdown export in media storage and return a `.invalid` link that can never reach a buyer;
 * the live adapters call the Google Sheets and Notion APIs once their keys exist (see `templateBackends`).
 */

export interface TemplateTab {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}
export interface TemplateSpec {
  readonly title: string;
  readonly tabs: readonly TemplateTab[];
}
export interface TemplateResult {
  /** The link buyers use: Sheets "make a copy", Notion "duplicate". */
  readonly url: string;
  readonly provider: string;
  /** A stored export (fakes). */
  readonly storageKey?: string;
}
export interface SheetsTemplateProvider {
  readonly name: string;
  createTemplate(spec: TemplateSpec, ctx: { keyPrefix: string }): Promise<TemplateResult>;
}
export interface NotionTemplateProvider {
  readonly name: string;
  createTemplate(spec: TemplateSpec, ctx: { keyPrefix: string }): Promise<TemplateResult>;
}

/** Trackers → one tab each (tick columns), checklists → a "Checklist" tab, tables → their own tabs. */
export function templateSpec(doc: ProductDoc): TemplateSpec {
  const tabs: TemplateTab[] = [];
  const checks: string[][] = [];
  const used = new Set<string>();
  const tabName = (s: string) => {
    let base = plainInline(s).replace(/[[\]*?:/\\]/g, '').slice(0, 28).trim() || 'Sheet';
    let n = 2;
    while (used.has(base)) base = `${base.slice(0, 25)} ${n++}`;
    used.add(base);
    return base;
  };
  for (const s of doc.sections) {
    for (const b of s.blocks) {
      if (b.t === 'tracker') tabs.push({ name: tabName(b.title), columns: ['Item', ...b.columns.map(plainInline)], rows: b.rows.map((r) => [plainInline(r), ...b.columns.map(() => 'FALSE')]) });
      else if (b.t === 'table') tabs.push({ name: tabName(s.title), columns: b.header.map(plainInline), rows: b.rows.map((r) => r.map(plainInline)) });
      else if (b.t === 'checklist') for (const it of b.items) checks.push([plainInline(s.title), plainInline(it), 'FALSE']);
      else if (b.t === 'fillin') checks.push([plainInline(s.title), plainInline(b.prompt), '']);
    }
  }
  if (checks.length) tabs.push({ name: tabName('Checklist'), columns: ['Section', 'Item', 'Done'], rows: checks });
  return { title: plainInline(doc.title), tabs };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function specToCsv(tab: TemplateTab): string {
  return [tab.columns, ...tab.rows].map((r) => r.map(csvCell).join(',')).join('\n');
}
export function specToMarkdown(spec: TemplateSpec): string {
  return [
    `# ${spec.title}`,
    ...spec.tabs.flatMap((t) => [`\n## ${t.name}`, `| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`, ...t.rows.map((r) => `| ${r.map((c) => (c === 'FALSE' ? '[ ]' : c)).join(' | ')} |`)]),
  ].join('\n');
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export class FakeSheetsTemplates implements SheetsTemplateProvider {
  readonly name = 'fake-sheets';
  readonly created: TemplateSpec[] = [];
  constructor(private readonly storage: MediaStore) {}
  async createTemplate(spec: TemplateSpec, ctx: { keyPrefix: string }): Promise<TemplateResult> {
    this.created.push(spec);
    const key = `${ctx.keyPrefix}/sheet-template.csv`;
    await this.storage.put({ key, data: spec.tabs.map((t) => `# ${t.name}\n${specToCsv(t)}`).join('\n\n'), contentType: 'text/csv' });
    return { url: `https://sheets.fake.invalid/${shortHash(JSON.stringify(spec))}/copy`, provider: this.name, storageKey: key };
  }
}

export class FakeNotionTemplates implements NotionTemplateProvider {
  readonly name = 'fake-notion';
  readonly created: TemplateSpec[] = [];
  constructor(private readonly storage: MediaStore) {}
  async createTemplate(spec: TemplateSpec, ctx: { keyPrefix: string }): Promise<TemplateResult> {
    this.created.push(spec);
    const key = `${ctx.keyPrefix}/notion-template.md`;
    await this.storage.put({ key, data: specToMarkdown(spec), contentType: 'text/markdown' });
    return { url: `https://notion.fake.invalid/${shortHash(JSON.stringify(spec))}/duplicate`, provider: this.name, storageKey: key };
  }
}

/**
 * Google Sheets API v4 with an OAuth access token (a service account's or the Owner's). Creates the spreadsheet with
 * one sheet per tab, writes the values, makes it readable by anyone with the link, and returns the `/copy` link.
 */
export class GoogleSheetsTemplates implements SheetsTemplateProvider {
  readonly name = 'google-sheets';
  constructor(
    private readonly token: () => Promise<string> | string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async call<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
    const res = await this.fetchImpl(url, { method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
  async createTemplate(spec: TemplateSpec): Promise<TemplateResult> {
    const sheet = await this.call<{ spreadsheetId: string }>('https://sheets.googleapis.com/v4/spreadsheets', {
      properties: { title: spec.title },
      sheets: spec.tabs.map((t) => ({ properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } })),
    });
    await this.call(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values:batchUpdate`, {
      valueInputOption: 'USER_ENTERED',
      data: spec.tabs.map((t) => ({ range: `'${t.name}'!A1`, values: [t.columns, ...t.rows] })),
    });
    await this.call(`https://www.googleapis.com/drive/v3/files/${sheet.spreadsheetId}/permissions`, { role: 'reader', type: 'anyone' });
    return { url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/copy`, provider: this.name };
  }
}

/** Notion API: a page under the studio's template parent with one database per tab; buyers duplicate the public page. */
export class NotionTemplates implements NotionTemplateProvider {
  readonly name = 'notion';
  constructor(
    private readonly token: string,
    private readonly parentPageId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.notion.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
  async createTemplate(spec: TemplateSpec): Promise<TemplateResult> {
    const page = await this.call<{ id: string; url: string; public_url?: string | null }>('pages', {
      parent: { page_id: this.parentPageId },
      properties: { title: { title: [{ text: { content: spec.title } }] } },
    });
    for (const t of spec.tabs) {
      const [first, ...rest] = t.columns;
      const db = await this.call<{ id: string }>('databases', {
        parent: { page_id: page.id },
        title: [{ text: { content: t.name } }],
        properties: { [first ?? 'Item']: { title: {} }, ...Object.fromEntries(rest.map((c) => [c, { checkbox: {} }])) },
      });
      for (const r of t.rows) {
        await this.call('pages', {
          parent: { database_id: db.id },
          properties: { [first ?? 'Item']: { title: [{ text: { content: r[0] ?? '' } }] }, ...Object.fromEntries(rest.map((c, i) => [c, { checkbox: r[i + 1] === 'TRUE' }])) },
        });
      }
    }
    return { url: page.public_url ?? page.url, provider: this.name };
  }
}

/** Which templates a product wants: from the brief's format ("Google Sheets template", "Notion") or the manuscript's front matter. */
export function wantedTemplates(format: string, explicit: ReadonlyArray<'sheet' | 'notion'> = []): Array<'sheet' | 'notion'> {
  const out = new Set(explicit);
  if (/sheet|spreadsheet/i.test(format)) out.add('sheet');
  if (/notion/i.test(format)) out.add('notion');
  return [...out];
}

export const hasTemplateContent = (doc: ProductDoc) => doc.sections.some((s) => s.blocks.some((b) => (b.t === 'tracker' || b.t === 'checklist' || b.t === 'table') && blockStrings(b).length > 0));
