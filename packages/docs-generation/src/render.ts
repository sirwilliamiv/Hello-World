/**
 * The render path, and the place the determinism guarantee is actually kept.
 *
 * `renderHtml(templateVersion, data)` is a pure function of:
 *   - the pinned template version's source (append-only, so it cannot change),
 *   - the canonicalised data,
 *   - the configured page size, margin, and token stylesheet,
 *   - the helper table (built-ins plus the client's `templateHelpers` slot).
 *
 * Nothing in it reads a clock, generates an id, consults a locale, or iterates an
 * object in insertion order. Rendering the same version with the same data twice
 * therefore produces the same bytes, and `renderPdf` normalises away the three fields
 * Chromium would otherwise vary.
 */
import { documents } from './config.js'
import { PdfEngineDisabledError, UnsupportedFormatError } from './errors.js'
import { templateHelpers, useMoney } from './helpers.js'
import { htmlToPdf } from './pdf.js'
import { runtime } from './ports.js'
import { isOutputFormatResult, type BrandingDecision, type OutputFormatDecision } from './slots.js'
import { documentShell } from './styling.js'
import { compile, sortDeep, type HelperTable } from './template-engine.js'
import { resolveTemplateVersion } from './templates.js'
import type { DocumentFormat, DocumentTemplate, TemplateRef, TemplateVersion } from './types.js'

/** Canonical JSON: key-sorted, no whitespace. The hash input and the reissue input. */
export function canonicalJson(data: unknown): string {
  return JSON.stringify(sortDeep(data) ?? null)
}

/** Built-in helpers, plus the client's slot, with money wired to kernel.money. */
export async function helperTable(): Promise<HelperTable> {
  const rt = await runtime()
  useMoney(rt.money)

  // What every template has with no slot implemented, and what `proceed()` returns.
  const registered = templateHelpers.all()
  const slot = documents().slots.templateHelpers
  if (slot === undefined) return registered

  const contributed = await slot({ registered, proceed: () => registered })
  // Client helpers are merged last so a client can override a built-in deliberately,
  // and merged *over* the registry so returning only their own adds rather than
  // silently removing `money` from every template in the product.
  return { ...registered, ...contributed }
}

async function branding(
  template: DocumentTemplate,
  version: TemplateVersion,
  format: DocumentFormat,
): Promise<BrandingDecision> {
  const cfg = documents()
  // The application's own branding: the kernel.ui tokens, nothing appended.
  const tokensOnly: BrandingDecision = { tokensHref: cfg.tokensHref }

  const slot = cfg.slots.brandingOverride
  if (slot === undefined) return tokensOnly
  // Every argument is a pinned render input, so a reissue re-derives the same
  // branding from the same document rather than from whatever is current.
  return slot({
    templateKey: template.key,
    templateVersion: version.version,
    format,
    pageSize: cfg.pageSize,
    tokensHref: cfg.tokensHref,
    proceed: () => tokensOnly,
  })
}

export interface RenderOptions {
  format?: DocumentFormat
}

/** Renders one pinned version. The core of every other entry point in this file. */
export async function renderVersionToHtml(
  template: DocumentTemplate,
  version: TemplateVersion,
  data: unknown,
  opts: RenderOptions = {},
): Promise<string> {
  const cfg = documents()
  const format = opts.format ?? cfg.defaultFormat
  const helpers = await helperTable()
  const body = compile(version.source).render(sortDeep(data), helpers)

  return documentShell({
    title: template.name,
    bodyHtml: body,
    tokensHref: cfg.tokensHref,
    tokensCss: cfg.tokensCss,
    pageSize: cfg.pageSize,
    margin: cfg.margin,
    branding: await branding(template, version, format),
  })
}

/**
 * `renderHtml(template, data)` from the specification's `renderers` interface.
 * Resolves and pins a version, then renders it.
 */
export async function renderHtml(
  template: TemplateRef,
  data: unknown,
  opts: RenderOptions & { templateVersion?: number } = {},
): Promise<string> {
  const resolved = await resolveTemplateVersion(template, opts.templateVersion)
  return renderVersionToHtml(resolved.template, resolved.version, data, opts)
}

/** `renderPdf(html)` from the specification's `renderers` interface. */
export async function renderPdf(html: string): Promise<Buffer> {
  const cfg = documents()
  if (cfg.pdfEngine === 'none') throw new PdfEngineDisabledError()
  return htmlToPdf(html, { pageSize: cfg.pageSize, margin: cfg.margin })
}

export interface RenderedBytes {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly extension: string
  readonly html: string
  /** The format actually written, after the `outputFormats` slot has had its say. */
  readonly format: DocumentFormat
}

/** `requested ?? default_format` — what `OutputFormatContext.proceed()` returns. */
export function selectedFormat(requested?: DocumentFormat): DocumentFormat {
  return requested ?? documents().defaultFormat
}

/**
 * HTML, PDF, or whatever the `outputFormats` slot supplies. The slot is consulted
 * before the built-ins, so a client can replace 'pdf' with their own pipeline.
 */
export async function renderToBytes(
  template: DocumentTemplate,
  version: TemplateVersion,
  data: unknown,
  requested?: DocumentFormat,
): Promise<RenderedBytes> {
  const cfg = documents()
  const selected = selectedFormat(requested)
  const html = await renderVersionToHtml(template, version, data, { format: selected })

  const slot = cfg.slots.outputFormats
  const decision: OutputFormatDecision =
    slot === undefined
      ? selected
      : await slot({
          format: selected,
          requested,
          configuredDefault: cfg.defaultFormat,
          html,
          templateKey: template.key,
          templateVersion: version,
          data,
          proceed: () => selected,
        })

  if (isOutputFormatResult(decision)) {
    return {
      bytes: decision.bytes,
      contentType: decision.contentType,
      extension: decision.extension,
      html,
      // A client-written format is still a format: it is what the document records.
      format: selected,
    }
  }

  const format = decision
  // A slot that switches the format switches the branding with it: `BrandingContext`
  // is told which format it is styling, so the shell is re-rendered rather than
  // shipped under a format it was not branded for.
  const finalHtml =
    format === selected ? html : await renderVersionToHtml(template, version, data, { format })

  if (format === 'html') {
    return {
      bytes: new TextEncoder().encode(finalHtml),
      contentType: 'text/html; charset=utf-8',
      extension: 'html',
      html: finalHtml,
      format,
    }
  }
  if (format === 'pdf') {
    const pdf = await renderPdf(finalHtml)
    return {
      bytes: new Uint8Array(pdf),
      contentType: 'application/pdf',
      extension: 'pdf',
      html: finalHtml,
      format,
    }
  }
  throw new UnsupportedFormatError(format)
}
