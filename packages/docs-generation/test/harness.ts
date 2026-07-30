/**
 * Test harness. In-memory stand-ins for `kernel.data`, `kernel.events`,
 * `kernel.identity`, `kernel.money`, and the slice of `data.files` a document needs.
 *
 * The files double copies data.files' actual semantics on purpose: a stored file is
 * quarantined until `clearScans()` runs, and `signedUrl` refuses an unscanned one.
 * A document that assumed its file was instantly retrievable would pass against a
 * naive double and fail in production.
 */
import {
  chromiumLaunchable,
  closePdfEngine,
  configureDocuments,
  resetDocumentsConfig,
  type DocsRuntime,
  type DocumentsConfigInput,
  type FilesPort,
  type MoneyLike,
  type RepositoryLike,
} from '../src/index.js'

type Row = { id: string } & Record<string, unknown>

export class InMemoryRepository<T extends { id: string }> implements RepositoryLike<T> {
  readonly rows = new Map<string, T>()

  async find(id: string): Promise<T | null> {
    return this.rows.get(id) ?? null
  }
  async findMany(where?: Partial<T>): Promise<T[]> {
    const all = [...this.rows.values()]
    if (where === undefined) return all
    const criteria = Object.entries(where) as [keyof T, unknown][]
    return all.filter((row) => criteria.every(([key, value]) => row[key] === value))
  }
  async create(value: T): Promise<T> {
    this.rows.set(value.id, { ...value })
    return { ...value }
  }
  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id)
    if (existing === undefined) throw new Error(`No row ${id}`)
    const next = { ...existing, ...patch }
    this.rows.set(id, next)
    return { ...next }
  }
  async softDelete(): Promise<void> {}
  async restore(): Promise<void> {}
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

/**
 * Stands in for kernel.money. Formats integer minor units with two decimals and a
 * symbol — deterministic, and never a float.
 */
export const fakeMoney: MoneyLike = {
  of(minor: number, currency: string) {
    if (!Number.isInteger(minor)) throw new Error('Money takes integer minor units')
    return {
      format(): string {
        const negative = minor < 0
        const digits = String(Math.abs(minor)).padStart(3, '0')
        const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        const fraction = digits.slice(-2)
        const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `
        return `${negative ? '-' : ''}${symbol}${whole}.${fraction}`
      },
    }
  },
}

export interface StoredFile {
  id: string
  filename: string
  contentType: string
  bytes: Uint8Array
  storageKey: string
  scanned: boolean
}

/** The slice of data.files a document uses, with its quarantine behaviour intact. */
export class FakeFiles implements FilesPort {
  readonly stored = new Map<string, StoredFile>()
  private next = 0

  async storeServerFile(input: {
    filename: string
    contentType: string
    bytes: Uint8Array
    storageKey?: string
  }): Promise<{ id: string }> {
    const key = input.storageKey ?? `documents/${this.next}`
    // A stable storage key means re-storing an identical rendering overwrites rather
    // than accumulating, exactly as it does in data.files.
    const existing = [...this.stored.values()].find((f) => f.storageKey === key)
    const id = existing?.id ?? `file-${++this.next}`
    this.stored.set(id, {
      id,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
      storageKey: key,
      scanned: existing?.scanned ?? false,
    })
    return { id }
  }

  async signedUrl(file: string, ttlSeconds = 300): Promise<string> {
    const stored = this.stored.get(file)
    // data.files answers 404 for a file that has not cleared scanning.
    if (stored === undefined || !stored.scanned) {
      const error = new Error(`No file ${file}`) as Error & { status: number }
      error.status = 404
      throw error
    }
    return `https://storage.test/${stored.storageKey}?expires=${ttlSeconds}&sig=test`
  }

  /** Stands in for the scan job clearing the queue. */
  clearScans(): void {
    for (const file of this.stored.values()) file.scanned = true
  }

  bytesOf(fileId: string): Uint8Array {
    const stored = this.stored.get(fileId)
    if (stored === undefined) throw new Error(`No file ${fileId}`)
    return stored.bytes
  }
}

export interface PublishedEvent {
  name: string
  payload: Record<string, unknown>
}

export interface DocsHarness {
  runtime: DocsRuntime
  files: FakeFiles
  events: PublishedEvent[]
  repos: {
    templates: InMemoryRepository<Row>
    versions: InMemoryRepository<Row>
    documents: InMemoryRepository<Row>
  }
  user: { id: string } | null
  cleanup(): void
}

export const TOKENS_HREF = '/generated/kernel.ui/tokens.css'

/** The token stylesheet a product would ship; branding is a token change, nothing else. */
export const TOKENS_CSS = `:root {
  --color-text: #101828;
  --color-accent: #1d4ed8;
  --font-body: 'Inter', system-ui, sans-serif;
  --font-size-body: 10.5pt;
}`

export function setupDocuments(overrides: Partial<DocumentsConfigInput> = {}): DocsHarness {
  const repos = {
    templates: new InMemoryRepository<Row>(),
    versions: new InMemoryRepository<Row>(),
    documents: new InMemoryRepository<Row>(),
  }
  const byEntity: Record<string, InMemoryRepository<Row>> = {
    DocumentTemplate: repos.templates,
    TemplateVersion: repos.versions,
    GeneratedDocument: repos.documents,
  }

  const events: PublishedEvent[] = []
  const files = new FakeFiles()
  const harness: Partial<DocsHarness> = { user: { id: 'user-1' } }

  const runtime: DocsRuntime = {
    repository: <T extends { id: string }>(entity: string) => {
      const repo = byEntity[entity]
      if (repo === undefined) throw new Error(`Unregistered entity ${entity}`)
      return repo as unknown as RepositoryLike<T>
    },
    publish: async (name, payload) => {
      events.push({ name, payload })
    },
    currentUser: async () => harness.user ?? null,
    money: fakeMoney,
    files,
  }

  resetDocumentsConfig()
  configureDocuments({
    defaultFormat: 'html',
    pageSize: 'letter',
    pdfEngine: 'chromium',
    tokensHref: TOKENS_HREF,
    tokensCss: TOKENS_CSS,
    runtime,
    ...overrides,
  })

  Object.assign(harness, {
    runtime,
    files,
    events,
    repos,
    cleanup: () => resetDocumentsConfig(),
  })
  return harness as DocsHarness
}

/**
 * Chromium is optional; the PDF tests skip rather than fail where it is absent.
 *
 * This probes by actually launching, through the same code path `renderPdf` uses.
 * Checking that `playwright` merely *imports* is not enough — the library resolves
 * fine while the browser revision it wants is missing, so an import-only probe claims
 * the engine is present and the suite then fails at the first render.
 */
export async function chromiumAvailable(): Promise<boolean> {
  const launchable = await chromiumLaunchable()
  await closePdfEngine()
  return launchable
}

export const INVOICE_TEMPLATE = `<h1>Invoice {{ invoice.number }}</h1>
<p class="customer">{{ invoice.customer_name }}</p>
<table>
  <thead><tr><th>Description</th><th class="numeric">Amount</th></tr></thead>
  <tbody>
  {{#each invoice.lines}}
    <tr><td>{{ this.description }}</td><td class="numeric">{{ money this.amount_minor ../invoice.currency }}</td></tr>
  {{/each}}
  </tbody>
</table>
<p class="total">Total due {{ money invoice.total_minor invoice.currency }} by {{ date invoice.due_at 'DD MMMM YYYY' }}</p>`

export const INVOICE_DATA = {
  invoice: {
    number: 'INV-2026-00042',
    customer_name: 'Acme & Sons <Holdings>',
    currency: 'USD',
    total_minor: 128_450,
    due_at: '2026-08-15T00:00:00.000Z',
    lines: [
      { description: 'Site survey', amount_minor: 95_000 },
      { description: 'Materials', amount_minor: 33_450 },
    ],
  },
}
