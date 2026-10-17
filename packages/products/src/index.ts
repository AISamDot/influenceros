import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@troupe/agents';
import type { Providers } from '@troupe/providers';
import { productJobs, productSchedules } from './jobs';
import { productTools } from './tools';

/**
 * @troupe/products (IOS-4 stream H): the Product Builder. A Monetization Agent brief or an imported markdown manuscript
 * → structured content (sections, named rules, tick-box trackers, fill-in pages, bonus pages) → styled HTML in the
 * persona's kit → PDFs (A4 and US Letter) through headless Chrome → QC QP → Gate → product_version files → listing
 * pack and the Owner's v1 card. Google Sheets / Notion templates sit behind interfaces with fakes. See
 * docs/IOS-34-CONTRACTS.md §4 (stream H).
 */
export * from './model';
export { parseManuscript, type ManuscriptMeta, type ParsedManuscript } from './manuscript';
export { AI_CREDIT_LINE, ADVICE_LINE, fakeDoc, parseDoc, promisedFromBrief, referralFor, withNextStepAndCredits, writeFromBrief } from './content';
export { blockHeight, layoutDoc, type Layout, type LayoutPage, type TocEntry } from './layout';
export { contrast, coverSvg, inline, printPalette, renderHtml } from './html';
export { ChromePdfRenderer, defaultPdfRenderer, FakePdfRenderer, findChrome, PdfRendererUnavailableError, type PdfRenderer, type PdfRenderResult } from './pdf';
export { inspectPdf, type PdfInspection } from './inspect';
export { HttpLinkChecker, linkSyntaxError, type LinkChecker, PLACEHOLDER_PATTERNS, runQp, saveQpReport, SyntaxLinkChecker, type QpResult } from './qp';
export {
  FakeNotionTemplates,
  FakeSheetsTemplates,
  GoogleSheetsTemplates,
  NotionTemplates,
  specToCsv,
  specToMarkdown,
  templateSpec,
  wantedTemplates,
  type NotionTemplateProvider,
  type SheetsTemplateProvider,
  type TemplateSpec,
} from './templates';
export { productBackends, setProductBackends, TEMPLATE_SECRETS, type ProductBackends } from './backends';
export { buildProduct, MAX_FIX_LOOPS, previewDoc, PRODUCT_BUILDER, type BuildOutcome, type BuildPayload } from './build';
export { importManuscript, listInbox, manuscriptsDir, scanInbox, type ImportResult } from './inbox';
export { PRODUCT_JOBS, sweepBriefs } from './jobs';
export { productStatus, requestBuild, type ProductStatusRow } from './tools';

// StudioModule exports, composed by @troupe/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = productTools;
export const jobs: JobHandlerMap = productJobs;
export const schedules: readonly ScheduledTask[] = productSchedules;
/** No `Providers` members: Chrome PDF, the link checker and Sheets/Notion are H's own backends (backends.ts). */
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
