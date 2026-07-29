export class DocumentsError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 500) {
    super(message)
    this.name = 'DocumentsError'
    this.code = code
    this.status = status
  }
}

export class TemplateNotFoundError extends DocumentsError {
  constructor(ref: string) {
    super('template_not_found', `No document template ${ref}`, 404)
    this.name = 'TemplateNotFoundError'
  }
}

export class TemplateVersionNotFoundError extends DocumentsError {
  constructor(templateId: string, version: number) {
    super(
      'template_version_not_found',
      `Template ${templateId} has no version ${version}. Template versions are append-only, ` +
        'so a version that was never published cannot appear later.',
      404,
    )
    this.name = 'TemplateVersionNotFoundError'
  }
}

export class TemplateSyntaxError extends DocumentsError {
  constructor(message: string) {
    super('template_syntax_error', message, 422)
    this.name = 'TemplateSyntaxError'
  }
}

/** `pdf_engine: 'none'` — output is restricted to HTML. */
export class PdfEngineDisabledError extends DocumentsError {
  constructor() {
    super(
      'pdf_engine_disabled',
      "PDF rendering is disabled (pdf_engine: 'none'). Generate with format 'html', or set " +
        "pdf_engine to 'chromium' in the docs.generation config.",
      501,
    )
    this.name = 'PdfEngineDisabledError'
  }
}

export class PdfEngineUnavailableError extends DocumentsError {
  constructor(detail: string) {
    super(
      'pdf_engine_unavailable',
      `Headless Chromium could not be started: ${detail}. Install the playwright browser, ` +
        "or set pdf_engine to 'none' to restrict output to HTML.",
      503,
    )
    this.name = 'PdfEngineUnavailableError'
  }
}

export class DocumentsConfigError extends DocumentsError {
  constructor(message: string) {
    super('documents_config_error', message)
    this.name = 'DocumentsConfigError'
  }
}

export class UnsupportedFormatError extends DocumentsError {
  constructor(format: string) {
    super(
      'unsupported_format',
      `No renderer for format '${format}'. PDF and HTML are built in; anything else comes ` +
        'from the outputFormats slot.',
      422,
    )
    this.name = 'UnsupportedFormatError'
  }
}
