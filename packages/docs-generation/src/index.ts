/**
 * @forge/docs-generation — Generating Documents (docs.generation@1.0.0)
 *
 * Two properties this package exists to hold:
 *
 *   1. **A reissued historical document is byte-identical.** Every rendering pins the
 *      template version it used, `TemplateVersion` is append-only in code and in the
 *      database, the document id is derived from its inputs, and the render path has
 *      no clock, no random source, and no locale-dependent formatting. Chromium's
 *      three varying PDF fields are normalised away.
 *   2. **Documents look like the product.** Styling comes from the `kernel.ui` token
 *      stylesheet the application already ships; this package sets no colour, typeface
 *      or size of its own, and money is formatted by `kernel.money` so an amount reads
 *      the same in an invoice, a quote, and a report.
 */

// The exposed interfaces.
export {
  generate,
  reissue,
  documentUrl,
  listDocuments,
  derivedUuid,
  sha256Hex,
  exportGeneratedDocuments,
  anonymizeGeneratedDocuments,
  type ReissueResult,
  type ExportedDocument,
} from './documents.js'
export {
  renderHtml,
  renderPdf,
  renderToBytes,
  renderVersionToHtml,
  canonicalJson,
  helperTable,
  type RenderOptions,
  type RenderedBytes,
} from './render.js'
export { TemplateEditor, type TemplateEditorProps } from './components/TemplateEditor.js'
export { templateHelpers, useMoney, type TemplateHelperRegistry } from './helpers.js'

// Configuration binding, called by src/generated/docs.generation/config.ts.
export {
  configureDocuments,
  documents,
  resetDocumentsConfig,
  type DocumentsConfig,
  type DocumentsConfigInput,
  type PdfEngine,
} from './config.js'

// Declared event handlers for `consumes`.
export {
  renderInvoice,
  renderQuote,
  renderJobSummary,
  renderReport,
  type DomainEvent,
} from './handlers.js'

// The template store. Append-only by construction.
export {
  createTemplate,
  publishTemplateVersion,
  findTemplate,
  getTemplateVersion,
  resolveTemplateVersion,
  templateVersion,
  listTemplates,
  listTemplateVersions,
  sourceHash,
  type CreateTemplateInput,
} from './templates.js'

// The engine, exported so a client can compile a template outside a document.
export { compile, sortDeep, stringify, type CompiledTemplate, type HelperTable } from './template-engine.js'
export { documentShell, type ShellOptions } from './styling.js'
export {
  normalisePdf,
  isPdf,
  closePdfEngine,
  chromiumLaunchable,
  htmlToPdf,
  type PdfOptions,
} from './pdf.js'

// Slot types.
export type {
  TemplateHelpersSlot,
  TemplateHelper,
  BrandingOverrideSlot,
  BrandingContext,
  BrandingDecision,
  OutputFormatsSlot,
  OutputFormatContext,
  OutputFormatResult,
  DocumentSlots,
  DocumentSlotsInput,
} from './slots.js'

// Schema, for the migration runner.
export {
  docsGenerationSchema,
  documentTemplatesTable,
  templateVersionsTable,
  generatedDocumentsTable,
} from './schema.js'

// Domain types.
export {
  DOCUMENT_ENTITIES,
  templateKeyOf,
  type DocumentTemplate,
  type TemplateVersion,
  type GeneratedDocument,
  type GenerateOptions,
  type TemplateRef,
  type DocumentFormat,
  type PageSize,
} from './types.js'

export {
  DocumentsError,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
  TemplateSyntaxError,
  PdfEngineDisabledError,
  PdfEngineUnavailableError,
  DocumentsConfigError,
  UnsupportedFormatError,
} from './errors.js'

export type { DocsRuntime, MoneyLike, FilesPort, RepositoryLike } from './ports.js'
