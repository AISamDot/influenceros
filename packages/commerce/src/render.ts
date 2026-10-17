import type { PersonaKit } from '@troupe/agents';
import { escapeHtml } from './util';

/**
 * Email HTML in the persona's palette. Bodies are plain text written by the email-writer (paragraphs separated by
 * blank lines, `{{first_name}}` allowed); everything is escaped, so model text can never inject markup. Every
 * marketing email carries the footer: why you're getting it, the unsubscribe link and the studio's physical address.
 */
export interface EmailFooter {
  readonly reason: string;
  /** Absolute unsubscribe URL, or Resend's broadcast placeholder. */
  readonly unsubscribeUrl: string | null;
  readonly physicalAddress: string | null;
}

export interface RenderedEmail {
  readonly html: string;
  readonly text: string;
}

const fill = (s: string, vars: Readonly<Record<string, string>>) => s.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');

/** Renders one email. `vars` fills `{{name}}` placeholders (first_name defaults to "there"). */
export function renderEmail(args: {
  personaName: string;
  colors: PersonaKit['colors'];
  preheader?: string;
  body: string;
  cta?: { label: string; url: string } | null;
  footer: EmailFooter;
  vars?: Readonly<Record<string, string>>;
}): RenderedEmail {
  const vars = { first_name: 'there', ...(args.vars ?? {}) };
  const body = fill(args.body, vars).trim();
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const { bg, ink, accent } = args.colors;
  // Contrast-checked picks (AA): the button fill and its text, and the accent as text on the background.
  const ctaFill = args.colors.cta ?? accent;
  const ctaText = args.colors.onCta ?? '#fff';
  const accentText = args.colors.accentText ?? ink;
  const pHtml = paras.map((p) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const cta = args.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(args.cta.url)}" style="background:${ctaFill};color:${ctaText};text-decoration:none;padding:12px 20px;border-radius:999px;display:inline-block;font-weight:600">${escapeHtml(args.cta.label)}</a></p>`
    : '';
  const f = args.footer;
  const footerLines = [
    escapeHtml(f.reason),
    f.unsubscribeUrl ? `<a href="${f.unsubscribeUrl.startsWith('{{{') ? f.unsubscribeUrl : escapeHtml(f.unsubscribeUrl)}" style="color:${ink}">Unsubscribe</a>` : '',
    f.physicalAddress ? escapeHtml(f.physicalAddress) : '',
  ].filter(Boolean);
  const pre = args.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(fill(args.preheader, vars))}</div>` : '';
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:${bg};color:${ink};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px">${pre}
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="margin:0 0 24px;font-weight:700;letter-spacing:.02em;color:${accentText}">${escapeHtml(args.personaName)}</p>
${pHtml}${cta}
<hr style="border:none;border-top:1px solid ${ink}22;margin:32px 0 16px">
<p style="margin:0;font-size:12px;line-height:1.5;opacity:.75">${footerLines.join('<br>')}</p>
</div></body></html>`;
  const text = [
    ...paras,
    ...(args.cta ? [`${args.cta.label}: ${args.cta.url}`] : []),
    '--',
    f.reason,
    ...(f.unsubscribeUrl ? [`Unsubscribe: ${f.unsubscribeUrl}`] : []),
    ...(f.physicalAddress ? [f.physicalAddress] : []),
  ].join('\n\n');
  return { html, text };
}
