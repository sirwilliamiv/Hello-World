/**
 * The shapes `docs.generation` owns.
 *
 * The load-bearing field in this file is `TemplateVersion.version`, and the fact that
 * `GeneratedDocument` stores it. A rendering references the template *version* it
 * used, never the template, so editing a template cannot retroactively restyle a
 * document that was already issued.
 */

export type DocumentFormat = 'pdf' | 'html' | (string & {})
export type PageSize = 'letter' | 'a4'

/** A template by key, optionally pinned to a version. */
export type TemplateRef = string | { readonly id?: string; readonly key?: string; readonly version?: number }

export interface DocumentTemplate {
  readonly id: string
  /** Stable client-facing key: `invoice`, `quote`, `job-summary`. */
  key: string
  name: string
  description: string | null
  /** The version a new rendering uses when it does not pin one. */
  currentVersion: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Append-only. There is no update path for a version's source anywhere in this
 * package — publishing an edit inserts a new row.
 */
export interface TemplateVersion {
  readonly id: string
  templateId: string
  version: number
  source: string
  /** Checksum of the source, so a reissue can prove it rendered the same text. */
  sourceHash: string
  createdBy: string | null
  createdAt: Date
}

export interface GeneratedDocument {
  readonly id: string
  templateId: string
  templateKey: string
  /** The pin. This is what makes a reissue byte-identical. */
  templateVersion: number
  format: DocumentFormat
  /** The `data.files` id the rendering is stored under. */
  fileId: string | null
  /** SHA-256 of the rendered bytes. Two identical renderings share it. */
  contentHash: string
  /** SHA-256 of the canonicalised render data. */
  dataHash: string
  /** Canonical JSON of the render data, so the document can be reissued. */
  data: string | null
  /** What the document is about: `Invoice:inv-42`. */
  subjectRef: string | null
  generatedBy: string | null
  anonymisedAt: Date | null
  createdAt: Date
}

export interface GenerateOptions {
  /** Defaults to the configured `defaultFormat`. */
  format?: DocumentFormat
  /** Pin explicitly. Overrides the version on the ref. */
  templateVersion?: number
  subjectRef?: string
  /** Download filename. Derived from the template key when absent. */
  filename?: string
  /** Skip storing the rendering as a file. Used by previews. */
  store?: boolean
}

export const DOCUMENT_ENTITIES = {
  template: 'DocumentTemplate',
  templateVersion: 'TemplateVersion',
  document: 'GeneratedDocument',
} as const

export function templateKeyOf(ref: TemplateRef): { key?: string; id?: string; version?: number } {
  if (typeof ref === 'string') return { key: ref }
  return {
    ...(ref.key === undefined ? {} : { key: ref.key }),
    ...(ref.id === undefined ? {} : { id: ref.id }),
    ...(ref.version === undefined ? {} : { version: ref.version }),
  }
}
