/**
 * Configuration binding for `src/generated/docs.generation/config.ts`.
 */
import { z } from 'zod'
import { DocumentsConfigError } from './errors.js'
import type { DocumentSlotsInput } from './slots.js'
import type { DocsRuntime } from './ports.js'
import type { DocumentFormat, PageSize } from './types.js'

export type PdfEngine = 'chromium' | 'none'

/** Exactly the shape `templates/docs.generation/config.ts.tmpl` renders, plus test seams. */
export interface DocumentsConfigInput {
  defaultFormat: DocumentFormat
  pageSize: PageSize
  pdfEngine: PdfEngine
  /** The kernel.ui token stylesheet every document links. */
  tokensHref: string
  slots?: DocumentSlotsInput | undefined

  // ── Not rendered by the template ──
  /**
   * The token stylesheet's contents. Chromium renders from a string with no origin,
   * so a relative href cannot be fetched; when this is supplied the tokens are
   * inlined and the PDF carries the product's branding. Supplying it also removes
   * the last input a reissue could not reproduce.
   */
  tokensCss?: string | undefined
  /** Page margin, CSS length. Default 18mm. */
  margin?: string | undefined
  /** Injected ports, for tests. Defaults to the real `@forge/*` packages. */
  runtime?: DocsRuntime | undefined
}

const inputSchema = z.object({
  defaultFormat: z.string().min(1),
  pageSize: z.enum(['letter', 'a4']),
  pdfEngine: z.enum(['chromium', 'none']),
  tokensHref: z.string().min(1),
})

export interface DocumentsConfig {
  readonly defaultFormat: DocumentFormat
  readonly pageSize: PageSize
  readonly pdfEngine: PdfEngine
  readonly tokensHref: string
  readonly tokensCss: string | undefined
  readonly margin: string
  readonly slots: DocumentSlotsInput
  readonly runtime: DocsRuntime | undefined
}

let active: DocumentsConfig | null = null

export function configureDocuments(input: DocumentsConfigInput): DocumentsConfig {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new DocumentsConfigError(`Invalid docs.generation configuration — ${detail}`)
  }

  // Caught at boot rather than at the first invoice: a product whose default format is
  // PDF with no PDF engine cannot render anything.
  if (input.pdfEngine === 'none' && input.defaultFormat === 'pdf') {
    throw new DocumentsConfigError(
      "docs.generation: pdf_engine is 'none' but default_format is 'pdf'. " +
        "Set default_format to 'html' in the capability config, or enable the chromium engine.",
    )
  }

  active = {
    defaultFormat: input.defaultFormat,
    pageSize: input.pageSize,
    pdfEngine: input.pdfEngine,
    tokensHref: input.tokensHref,
    tokensCss: input.tokensCss,
    margin: input.margin ?? '18mm',
    slots: input.slots ?? {},
    runtime: input.runtime,
  }
  return active
}

export function documents(): DocumentsConfig {
  if (active === null) {
    throw new DocumentsConfigError(
      'docs.generation is not configured. The generated product imports ' +
        "'@/generated/docs.generation/config' at boot; a test must call configureDocuments() itself.",
    )
  }
  return active
}

/** Test seam. Not part of the capability's exposed interface. */
export function resetDocumentsConfig(): void {
  active = null
}
