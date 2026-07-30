/**
 * The three extension points `docs.generation` declares.
 *
 * `brandingOverride` is the interesting one: a document's styling comes from
 * `kernel.ui` tokens by default, so a client that rebrands the product rebrands its
 * documents with it. The slot exists for the case that genuinely differs — a
 * letterhead on contracts but not on receipts — and it *adds to* the tokens rather
 * than replacing them, so an override cannot quietly detach a document from the
 * product's design system.
 *
 * Every context carries `proceed()`, returning exactly what the capability does with
 * no slot implemented (schemas/capability.schema.json, `$defs.slot.signature`), so
 * the stub Forge seeds is a correct one-liner:
 *
 *     export const brandingOverride: BrandingOverrideSlot = async (ctx) => ctx.proceed()
 *
 * Everything a slot is given is a *pinned* render input — the template key, the
 * pinned version, the format, the page size, the token stylesheet. That is not a
 * convenience: a document is reissued from its pin, so anything a slot reads that is
 * not in its context is a way to make a historical document render differently the
 * second time.
 */
import type { DocumentFormat, PageSize, TemplateVersion } from './types.js'

export type MaybePromise<T> = T | Promise<T>

// ── templateHelpers ─────────────────────────────────────────────────────────────

/** A helper is called with the arguments written in the template, in order. */
export type TemplateHelper = (...args: readonly unknown[]) => string

export type HelperMap = Readonly<Record<string, TemplateHelper>>

export interface TemplateHelpersContext {
  /**
   * The helpers every template already has: the built-ins plus whatever the
   * installed capabilities contributed to the `templateHelpers` registry. This is
   * the table with no slot implemented, so `return ctx.proceed()` is a no-op and
   * `return { ...ctx.proceed(), reference }` adds one.
   */
  proceed(): HelperMap
  /** Same table, for a slot that wants to read it without deferring. */
  readonly registered: HelperMap
}

/**
 * "Client-specific formatting helpers available to every template."
 * Must be pure: a helper that reads the clock or a random source breaks the
 * byte-identical reissue guarantee, which is the whole point of the capability.
 */
export type TemplateHelpersSlot = (ctx: TemplateHelpersContext) => MaybePromise<HelperMap>

// ── brandingOverride ────────────────────────────────────────────────────────────

export interface BrandingContext {
  readonly templateKey: string
  readonly templateVersion: number
  readonly format: DocumentFormat
  readonly pageSize: PageSize
  /** The application's kernel.ui token stylesheet. */
  readonly tokensHref: string
  /**
   * The application's own branding: the kernel.ui tokens, and nothing else. A
   * document that defers here is styled by the product's design system, which is the
   * behaviour with no slot implemented.
   */
  proceed(): BrandingDecision
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
  /** The format being produced: what the caller asked for, else the configured default. */
  readonly format: DocumentFormat
  /** What the caller asked for, if anything. */
  readonly requested: DocumentFormat | undefined
  /** `default_format` from the capability's configuration. */
  readonly configuredDefault: DocumentFormat
  /** The rendered HTML, already branded. */
  readonly html: string
  readonly templateKey: string
  readonly templateVersion: Readonly<TemplateVersion>
  readonly data: unknown
  /**
   * `requested ?? configuredDefault`, written by the built-in HTML and PDF writers —
   * exactly what is produced with no slot implemented.
   */
  proceed(): DocumentFormat
}

export interface OutputFormatResult {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly extension: string
}

/**
 * A format name — rendered by the built-in HTML/PDF writers, or rejected with
 * `UnsupportedFormatError` if nothing can write it — or the bytes themselves.
 */
export type OutputFormatDecision = DocumentFormat | OutputFormatResult

/**
 * "Client-specific output formats beyond PDF and HTML." Returning `ctx.proceed()`
 * defers to the built-in renderers; returning bytes supplies a format the capability
 * does not know about.
 */
export type OutputFormatsSlot = (
  ctx: OutputFormatContext,
) => MaybePromise<OutputFormatDecision>

/** Distinguishes the two arms of {@link OutputFormatDecision}. */
export function isOutputFormatResult(
  decision: OutputFormatDecision,
): decision is OutputFormatResult {
  return typeof decision !== 'string'
}

// ── the bundle the generated config passes in ───────────────────────────────────

export interface DocumentSlots {
  templateHelpers: TemplateHelpersSlot
  brandingOverride: BrandingOverrideSlot
  outputFormats: OutputFormatsSlot
}

export type DocumentSlotsInput = Partial<DocumentSlots>
