import {
  configureDocuments,
  createTemplate,
  resetDocumentsConfig,
  type DocsRuntime,
  type FilesPort,
  type RepositoryLike,
} from '@forge/docs-generation'
import { Money } from '@forge/kernel-money'
import {
  CREDIT_NOTE_TEMPLATE_ID,
  INVOICE_TEMPLATE_ID,
  RECEIPT_TEMPLATE_ID,
} from '../config.js'

/**
 * In-memory ports for the capabilities docs.generation requires and pay.invoices
 * does not: kernel.data (the template and document tables), data.files (where a
 * rendering is stored), and kernel.identity (the actor).
 *
 * These are seams, not doubles of docs.generation. The real package does the
 * work — appending template versions, canonicalising the render data, deriving the
 * document id, and pinning the version — so the byte-identical-reissue contract is
 * tested against the implementation that has to hold it rather than against a
 * restatement of it. kernel.money is passed through as the real `Money`, because
 * amounts in a document are formatted by kernel.money and by nothing else.
 */

type Row = { id: string } & Record<string, unknown>

class InMemoryRepository<T extends { id: string }> implements RepositoryLike<T> {
  readonly rows = new Map<string, T>()

  find(id: string): Promise<T | null> {
    return Promise.resolve(this.rows.get(id) ?? null)
  }
  findMany(where?: Partial<T>): Promise<T[]> {
    const all = [...this.rows.values()]
    if (where === undefined) return Promise.resolve(all)
    const criteria = Object.entries(where) as [keyof T, unknown][]
    return Promise.resolve(all.filter((row) => criteria.every(([k, v]) => row[k] === v)))
  }
  create(value: T): Promise<T> {
    this.rows.set(value.id, { ...value })
    return Promise.resolve({ ...value })
  }
  update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id)
    if (existing === undefined) throw new Error(`no row ${id}`)
    const next = { ...existing, ...patch }
    this.rows.set(id, next)
    return Promise.resolve({ ...next })
  }
  softDelete(): Promise<void> {
    return Promise.resolve()
  }
  restore(): Promise<void> {
    return Promise.resolve()
  }
  delete(id: string): Promise<void> {
    this.rows.delete(id)
    return Promise.resolve()
  }
}

export interface StoredFile {
  readonly id: string
  readonly filename: string
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly storageKey: string
}

/**
 * The slice of data.files a rendering needs. A stable storage key means re-storing
 * an identical rendering overwrites rather than accumulating, exactly as it does in
 * data.files — which is why `renders` counts CALLS rather than rows: it answers
 * "how many times were bytes produced", which is what the pinning tests ask.
 */
class FakeFiles implements FilesPort {
  readonly stored = new Map<string, StoredFile>()
  renders = 0
  private next = 0

  storeServerFile(input: {
    filename: string
    contentType: string
    bytes: Uint8Array
    storageKey?: string
  }): Promise<{ id: string }> {
    this.renders += 1
    const storageKey = input.storageKey ?? `documents/${String(this.next)}`
    const existing = [...this.stored.values()].find((f) => f.storageKey === storageKey)
    this.next += 1
    const id = existing?.id ?? `file_${String(this.next)}`
    this.stored.set(id, {
      id,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
      storageKey,
    })
    return Promise.resolve({ id })
  }

  signedUrl(file: string): Promise<string> {
    const stored = this.stored.get(file)
    if (stored === undefined) throw new Error(`no file ${file}`)
    return Promise.resolve(`https://storage.test/${stored.storageKey}`)
  }

  bytesOf(fileId: string | null): Uint8Array {
    if (fileId === null) throw new Error('document was not stored')
    const stored = this.stored.get(fileId)
    if (stored === undefined) throw new Error(`no file ${fileId}`)
    return stored.bytes
  }
}

export interface DocsHarness {
  readonly files: FakeFiles
  /** Template id (not key) per template key, for `publishTemplateVersion`. */
  readonly templateIds: Readonly<Record<string, string>>
  /** How many times docs.generation actually rendered and stored a document. */
  renderCount(): number
  cleanup(): void
}

/** The three templates pay.invoices renders. Deliberately trivial and stable. */
const TEMPLATE_SOURCES: Readonly<Record<string, { name: string; source: string }>> = {
  [INVOICE_TEMPLATE_ID]: {
    name: 'Invoice',
    source: '<h1>{{ number }}</h1><p>{{ money totalMinor currency }}</p>',
  },
  [RECEIPT_TEMPLATE_ID]: {
    name: 'Receipt',
    source: '<h1>{{ receiptId }}</h1><p>{{ money amountMinor currency }}</p>',
  },
  [CREDIT_NOTE_TEMPLATE_ID]: {
    name: 'Credit note',
    source: '<h1>{{ creditNoteId }}</h1><p>{{ reason }}</p>',
  },
}

export async function setupDocuments(): Promise<DocsHarness> {
  const repositories: Record<string, InMemoryRepository<Row>> = {
    DocumentTemplate: new InMemoryRepository<Row>(),
    TemplateVersion: new InMemoryRepository<Row>(),
    GeneratedDocument: new InMemoryRepository<Row>(),
  }
  const files = new FakeFiles()

  const runtime: DocsRuntime = {
    repository: <T extends { id: string }>(entity: string): RepositoryLike<T> => {
      const repository = repositories[entity]
      if (repository === undefined) throw new Error(`unregistered entity ${entity}`)
      return repository as unknown as RepositoryLike<T>
    },
    publish: () => Promise.resolve(),
    currentUser: () => Promise.resolve(null),
    money: Money,
    files,
  }

  resetDocumentsConfig()
  configureDocuments({
    defaultFormat: 'html',
    pageSize: 'a4',
    // No Chromium in this suite; HTML renderings prove the same determinism.
    pdfEngine: 'none',
    tokensHref: '/generated/kernel.ui/tokens.css',
    runtime,
  })

  const templateIds: Record<string, string> = {}
  for (const [key, definition] of Object.entries(TEMPLATE_SOURCES)) {
    const { template } = await createTemplate({ key, ...definition })
    templateIds[key] = template.id
  }

  return {
    files,
    templateIds,
    renderCount: () => files.renders,
    cleanup: () => {
      resetDocumentsConfig()
    },
  }
}
