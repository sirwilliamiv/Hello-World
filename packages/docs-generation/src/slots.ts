/**
 * The three extension points `docs.generation` declares.
 *
 * `brandingOverride` is the interesting one: a document's styling comes from
 * `kernel.ui` tokens by default, so a client that rebrands the product rebrands its
 * documents with it. The slot exists for the case that genuinely differs — a
 * letterhead on contracts but not on receipts — and it *adds to* the tokens rather
 * than replacing them, so an override cannot quietly detach a document from the
 * product's design system.
 */
import type { DocumentFormat, PageSize, TemplateVersion } from './types.js'

export type MaybePromise<T> = T | Promise<T>

// ── templateHelpers ─────────────────────────────────────────────────────────────

/** A helper is called with the arguments written in the template, in order. */
export type TemplateHelper = (...args: readonly unknown[]) => string

/**
 * "Client-specific formatting helpers available to every template."
 * Must be pure: a helper that reads the clock or a random source breaks the
 * byte-identical reissue guarantee, which is the whole point of the capability.
 */
export type TemplateHelpersSlot = () => MaybePromise<Readonly<Record<string, TemplateHelper>>>

// ── brandingOverride ────────────────────────────────────────────────────────────

export interface BrandingContext {
  readonly templateKey: string
  readonly templateVersion: number
  readonly format: DocumentFormat
  readonly pageSize: PageSize
  /** The application's kernel.ui token stylesheet. */
  readonly tokensHref: string
}

export interface BrandingDecision {
  /** Replace the token stylesheet href — rarely the right answer. */
  readonly tokensHref?: string
  /** CSS appended after the tokens, so it can only override deliberately. */
  readonly css?: string
  /** Markup placed at the top of every page, e.g. a letterhead. */
  readonly headerHtml?: string
  readonly footerHtml?: string
}

/** "Per-document-type branding that differs from the application's kernel.ui tokens." */
export type BrandingOverrideSlot = (ctx: BrandingContext) => MaybePromise<BrandingDecision>

// ── outputFormats ───────────────────────────────────────────────────────────────

export interface OutputFormatContext {
  readonly format: DocumentFormat
  /** The rendered HTML, already branded. */
  readonly html: string
  readonly templateVersion: Readonly<TemplateVersion>
  readonly data: unknown
}

export interface OutputFormatResult {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly extension: string
}

/**
 * "Client-specific output formats beyond PDF and HTML." Returning null defers to the
 * built-in renderers.
 */
export type OutputFormatsSlot = (
  ctx: OutputFormatContext,
) => MaybePromise<OutputFormatResult | null>

// ── the bundle the generated config passes in ───────────────────────────────────

export interface DocumentSlots {
  templateHelpers: TemplateHelpersSlot
  brandingOverride: BrandingOverrideSlot
  outputFormats: OutputFormatsSlot
}

export type DocumentSlotsInput = Partial<DocumentSlots>
