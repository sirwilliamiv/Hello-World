import type {
  CreditNoteRow,
  InvoiceLineRow,
  InvoiceRow,
  InvoiceStore,
  InvoiceTx,
  ReceiptRow,
} from '../db/port.js'

/**
 * An in-memory `InvoiceStore` that reproduces the Postgres behaviour the
 * gaplessness and idempotency guarantees rest on. It is deliberately built from
 * generic primitives rather than from invoice-specific special cases, so the
 * concurrency test exercises the CODE UNDER TEST rather than a store written to
 * make that code pass:
 *
 *  - ROW LOCKS. `allocateInvoiceNumber` takes an exclusive lock on
 *    (legal_entity, period) and holds it until the transaction ends, exactly as
 *    `INSERT … ON CONFLICT … DO UPDATE` does. A second transaction awaits it.
 *  - UNDO LOG. Every mutation records how to reverse itself; a throw inside the
 *    transaction body replays the log backwards, which is what returns an
 *    allocated number rather than burning it.
 *  - UNIQUE INDEXES. `insertReceiptIfAbsent` and `insertCreditNoteIfAbsent` take
 *    a lock on the index key and then conflict-check, so two concurrent
 *    applications of one charge cannot both succeed.
 *
 * There is no snapshot isolation here. That makes this store HARSHER than
 * Postgres, not weaker: any correctness that depends on isolation rather than on
 * the locks and constraints above will fail here.
 */

class KeyedLocks {
  private readonly tails = new Map<string, Promise<void>>()

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(
      key,
      previous.then(() => held),
    )
    await previous
    return release
  }
}

interface Tables {
  sequences: Map<string, number>
  invoices: InvoiceRow[]
  lines: InvoiceLineRow[]
  receipts: ReceiptRow[]
  creditNotes: CreditNoteRow[]
}

type Undo = () => void

export interface MemoryStoreStats {
  /** How many transactions had to wait for a sequence row lock. */
  sequenceLockWaits: number
  /** How many transactions rolled back. */
  rollbacks: number
  commits: number
}

export class MemoryInvoiceStore implements InvoiceStore {
  private readonly tables: Tables = {
    sequences: new Map(),
    invoices: [],
    lines: [],
    receipts: [],
    creditNotes: [],
  }

  private readonly locks = new KeyedLocks()

  readonly stats: MemoryStoreStats = { sequenceLockWaits: 0, rollbacks: 0, commits: 0 }

  get state(): Readonly<Tables> {
    return this.tables
  }

  sequenceValue(legalEntity: string, period: string): number {
    return this.tables.sequences.get(`${legalEntity}|${period}`) ?? 0
  }

  async transaction<T>(fn: (tx: InvoiceTx) => Promise<T>): Promise<T> {
    const undo: Undo[] = []
    const releases: (() => void)[] = []
    const tx = this.makeTx(undo, releases)

    try {
      const result = await fn(tx)
      this.stats.commits += 1
      return result
    } catch (error) {
      for (let i = undo.length - 1; i >= 0; i -= 1) (undo[i] as Undo)()
      this.stats.rollbacks += 1
      throw error
    } finally {
      // Locks are held to the end of the transaction, as Postgres holds them.
      for (const release of releases) release()
    }
  }

  private makeTx(undo: Undo[], releases: (() => void)[]): InvoiceTx {
    const t = this.tables
    const locks = this.locks
    const stats = this.stats

    const lock = async (key: string): Promise<void> => {
      const before = performance.now()
      const release = await locks.acquire(key)
      if (performance.now() - before > 0.05) stats.sequenceLockWaits += 1
      releases.push(release)
    }

    return {
      async allocateInvoiceNumber(legalEntity, period) {
        const key = `${legalEntity}|${period}`
        await lock(`seq:${key}`)
        const previous = t.sequences.get(key)
        const next = (previous ?? 0) + 1
        t.sequences.set(key, next)
        undo.push(() => {
          if (previous === undefined) t.sequences.delete(key)
          else t.sequences.set(key, previous)
        })
        return next
      },
      async peekSequence(legalEntity, period) {
        return t.sequences.get(`${legalEntity}|${period}`) ?? 0
      },

      async insertInvoice(row) {
        if (t.invoices.some((i) => i.legalEntity === row.legalEntity && i.number === row.number)) {
          throw new Error(
            `duplicate key value violates unique constraint "invoice_number_key" (${row.number})`,
          )
        }
        if (
          t.invoices.some(
            (i) =>
              i.legalEntity === row.legalEntity &&
              i.period === row.period &&
              i.sequenceValue === row.sequenceValue,
          )
        ) {
          throw new Error('duplicate key value violates unique constraint "invoice_sequence_key"')
        }
        const stored: InvoiceRow = { ...row, metadata: { ...row.metadata } }
        t.invoices.push(stored)
        undo.push(() => {
          const idx = t.invoices.indexOf(stored)
          if (idx !== -1) t.invoices.splice(idx, 1)
        })
        return { ...stored }
      },
      async insertInvoiceLines(rows) {
        for (const row of rows) {
          const stored: InvoiceLineRow = { ...row, metadata: { ...row.metadata } }
          t.lines.push(stored)
          undo.push(() => {
            const idx = t.lines.indexOf(stored)
            if (idx !== -1) t.lines.splice(idx, 1)
          })
        }
      },
      async findInvoiceById(id) {
        const row = t.invoices.find((i) => i.id === id)
        return row === undefined ? null : { ...row }
      },
      async findInvoiceByNumber(legalEntity, number) {
        const row = t.invoices.find((i) => i.legalEntity === legalEntity && i.number === number)
        return row === undefined ? null : { ...row }
      },
      async findInvoiceByChargeId(chargeId) {
        const receipt = t.receipts.find((r) => r.chargeId === chargeId)
        if (receipt === undefined) return null
        const row = t.invoices.find((i) => i.id === receipt.invoiceId)
        return row === undefined ? null : { ...row }
      },
      async listInvoiceLines(invoiceId) {
        return t.lines.filter((l) => l.invoiceId === invoiceId).sort((a, b) => a.position - b.position)
      },
      async listInvoicesForCustomer(customerId) {
        return t.invoices.filter((i) => i.customerId === customerId)
      },
      async listOverdueInvoices(asOf) {
        return t.invoices.filter(
          (i) => (i.status === 'open' || i.status === 'part_paid') && i.dueAt.getTime() < asOf.getTime(),
        )
      },
      async updateInvoiceBalance(id, patch) {
        const idx = t.invoices.findIndex((i) => i.id === id)
        if (idx === -1) throw new Error(`no invoice ${id}`)
        const before = t.invoices[idx] as InvoiceRow
        const after: InvoiceRow = {
          ...before,
          ...(patch.paidMinor === undefined ? {} : { paidMinor: patch.paidMinor }),
          ...(patch.creditedMinor === undefined ? {} : { creditedMinor: patch.creditedMinor }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.voidedAt === undefined ? {} : { voidedAt: patch.voidedAt }),
        }
        t.invoices[idx] = after
        undo.push(() => {
          t.invoices[idx] = before
        })
        return { ...after }
      },
      async setInvoiceDocumentVersion(id, template, version) {
        const idx = t.invoices.findIndex((i) => i.id === id)
        if (idx === -1) return
        const before = t.invoices[idx] as InvoiceRow
        t.invoices[idx] = { ...before, documentTemplate: template, documentTemplateVersion: version }
        undo.push(() => {
          t.invoices[idx] = before
        })
      },

      async insertReceiptIfAbsent(row) {
        // Models the unique index on (invoice_id, charge_id): a concurrent
        // inserter blocks here and then finds the conflict.
        await lock(`receipt:${row.invoiceId}|${row.chargeId}`)
        if (t.receipts.some((r) => r.invoiceId === row.invoiceId && r.chargeId === row.chargeId)) {
          return null
        }
        const stored = { ...row }
        t.receipts.push(stored)
        undo.push(() => {
          const idx = t.receipts.indexOf(stored)
          if (idx !== -1) t.receipts.splice(idx, 1)
        })
        return { ...stored }
      },
      async listReceipts(invoiceId) {
        return t.receipts.filter((r) => r.invoiceId === invoiceId)
      },

      async insertCreditNoteIfAbsent(row) {
        if (row.refundId !== null) {
          await lock(`credit:${row.invoiceId}|${row.refundId}`)
          if (
            t.creditNotes.some((c) => c.invoiceId === row.invoiceId && c.refundId === row.refundId)
          ) {
            return null
          }
        }
        const stored = { ...row }
        t.creditNotes.push(stored)
        undo.push(() => {
          const idx = t.creditNotes.indexOf(stored)
          if (idx !== -1) t.creditNotes.splice(idx, 1)
        })
        return { ...stored }
      },
      async listCreditNotes(invoiceId) {
        return t.creditNotes.filter((c) => c.invoiceId === invoiceId)
      },

      async anonymiseCustomer(customerId, anonymousId) {
        let count = 0
        t.invoices.forEach((row, idx) => {
          if (row.customerId !== customerId) return
          const before = row
          t.invoices[idx] = { ...before, customerId: anonymousId, metadata: {} }
          undo.push(() => {
            t.invoices[idx] = before
          })
          count += 1
        })
        return count
      },
    }
  }
}
