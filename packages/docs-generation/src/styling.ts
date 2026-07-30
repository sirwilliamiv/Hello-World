/**
 * The document shell.
 *
 * A document's appearance comes from `kernel.ui` tokens — the same stylesheet the
 * application's own chrome uses — so branding a client brands their documents with
 * it and nobody designs an invoice twice. Nothing here sets a colour, a typeface, or
 * a size literally; every declaration is `var(--token, <minimal fallback>)`, and the
 * fallbacks exist only so a document is legible when a token is missing rather than
 * blank.
 */
import type { BrandingDecision } from './slots.js'
import type { PageSize } from './types.js'

export interface ShellOptions {
  readonly title: string
  readonly bodyHtml: string
  readonly tokensHref: string
  /** Inlined when known — Chromium renders from a string with no origin to fetch from. */
  readonly tokensCss: string | undefined
  readonly pageSize: PageSize
  readonly margin: string
  readonly branding: BrandingDecision
}

const PAGE_SIZES: Readonly<Record<PageSize, string>> = {
  letter: 'Letter',
  a4: 'A4',
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Base rules, entirely in terms of kernel.ui tokens. */
function baseCss(pageSize: PageSize, margin: string): string {
  return `@page { size: ${PAGE_SIZES[pageSize]}; margin: ${margin}; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: var(--font-size-body, 11pt);
  line-height: var(--line-height-body, 1.45);
  color: var(--color-text, #111);
  background: var(--color-surface, #fff);
}
h1, h2, h3 { font-family: var(--font-heading, var(--font-body, system-ui, sans-serif)); color: var(--color-heading, var(--color-text, #111)); }
a { color: var(--color-accent, var(--color-text, #111)); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: var(--space-2, 6px) var(--space-3, 10px); border-bottom: 1px solid var(--color-border, #ddd); }
th { color: var(--color-muted, #555); font-weight: 600; }
.numeric, td.numeric, th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.document-header, .document-footer { color: var(--color-muted, #555); }
.document-footer { margin-top: var(--space-6, 32px); border-top: 1px solid var(--color-border, #ddd); padding-top: var(--space-3, 10px); }`
}

/**
 * Assembles the page. The output is a pure function of its arguments — no clock, no
 * ids, no ordering that depends on anything but the arguments themselves.
 */
export function documentShell(opts: ShellOptions): string {
  const tokensHref = opts.branding.tokensHref ?? opts.tokensHref
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<link rel="stylesheet" href="${escapeHtml(tokensHref)}">`,
  ]
  if (opts.tokensCss !== undefined) {
    parts.push(`<style data-forge="kernel.ui tokens">\n${opts.tokensCss}\n</style>`)
  }
  parts.push(`<style data-forge="document base">\n${baseCss(opts.pageSize, opts.margin)}\n</style>`)
  if (opts.branding.css !== undefined) {
    parts.push(`<style data-forge="brandingOverride">\n${opts.branding.css}\n</style>`)
  }
  parts.push('</head>', '<body class="forge-document">')
  if (opts.branding.headerHtml !== undefined) {
    parts.push(`<header class="document-header">${opts.branding.headerHtml}</header>`)
  }
  parts.push(`<main class="document-body">${opts.bodyHtml}</main>`)
  if (opts.branding.footerHtml !== undefined) {
    parts.push(`<footer class="document-footer">${opts.branding.footerHtml}</footer>`)
  }
  parts.push('</body>', '</html>')
  return parts.join('\n')
}
