import type { StudioServices } from '@ios/agents';
import { defaultBackend, isSecretName, readSecret } from '@ios/secrets';
import { defaultPdfRenderer, type PdfRenderer } from './pdf';
import { HttpLinkChecker, type LinkChecker, SyntaxLinkChecker } from './qp';
import { FakeNotionTemplates, FakeSheetsTemplates, GoogleSheetsTemplates, type NotionTemplateProvider, NotionTemplates, type SheetsTemplateProvider } from './templates';

/**
 * Stream H's local tooling, behind its own interfaces (none of it lives in `Providers`): the PDF renderer, the link
 * checker and the Sheets / Notion template makers. Fakes under IOS_FAKE_PROVIDERS=1 (tests); headless Chrome and
 * live link checks otherwise; Sheets and Notion go live once their secrets exist (names below; until the integrator
 * adds them to @ios/secrets they resolve to null and the fakes are used).
 */
export interface ProductBackends {
  readonly pdf: PdfRenderer;
  readonly links: LinkChecker;
  readonly sheets: SheetsTemplateProvider;
  readonly notion: NotionTemplateProvider;
}

export const TEMPLATE_SECRETS = { sheetsToken: 'google.sheets_token', notionToken: 'notion.api_key', notionParent: 'notion.template_parent_id' } as const;

function secret(name: string, env: Readonly<Record<string, string | undefined>>): string | null {
  if (!isSecretName(name)) return null;
  return readSecret(name, defaultBackend(env), env)?.reveal() ?? null;
}

let override: Partial<ProductBackends> | null = null;

/** Tests (and the CLI) swap backends; pass null to restore the defaults. */
export function setProductBackends(b: Partial<ProductBackends> | null): void {
  override = b;
}

export function productBackends(services: Pick<StudioServices, 'providers'>, env: Readonly<Record<string, string | undefined>> = process.env): ProductBackends {
  const fake = env.IOS_FAKE_PROVIDERS === '1';
  const sheetsToken = fake ? null : secret(TEMPLATE_SECRETS.sheetsToken, env);
  const notionToken = fake ? null : secret(TEMPLATE_SECRETS.notionToken, env);
  const notionParent = fake ? null : secret(TEMPLATE_SECRETS.notionParent, env);
  const studioDomain = env.IOS_STUDIO_DOMAIN?.trim().toLowerCase();
  return {
    pdf: override?.pdf ?? defaultPdfRenderer(env),
    links: override?.links ?? (fake ? new SyntaxLinkChecker() : new HttpLinkChecker(studioDomain ? [studioDomain] : [])),
    sheets: override?.sheets ?? (sheetsToken ? new GoogleSheetsTemplates(() => sheetsToken) : new FakeSheetsTemplates(services.providers.storage)),
    notion: override?.notion ?? (notionToken && notionParent ? new NotionTemplates(notionToken, notionParent) : new FakeNotionTemplates(services.providers.storage)),
  };
}
