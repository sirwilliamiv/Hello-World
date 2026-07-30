import type {
  ChargeRow,
  PaymentMethodRow,
  PaymentStore,
  PaymentTx,
  RefundRow,
} from '../db/port.js'

/**
 * An in-memory `PaymentStore` with the transaction and unique-constraint
 * semantics the Postgres implementation relies on:
 *
 *  - a transaction sees its own writes and nobody else's until it commits;
 *  - a throw discards everything the transaction wrote;
 *  - `insertChargeIfAbsent` / `insertRefundIfAbsent` behave as
 *    `ON CONFLICT … DO NOTHING RETURNING *` against the committed unique index.
 */

interface Tables {
  charges: ChargeRow[]
  refunds: RefundRow[]
  paymentMethods: PaymentMethodRow[]
}

function clone(tables: Tables): Tables {
  return {
    charges: tables.charges.map((r) => ({ ...r, metadata: { ...r.metadata } })),
    refunds: tables.refunds.map((r) => ({ ...r })),
    paymentMethods: tables.paymentMethods.map((r) => ({ ...r })),
  }
}

export class MemoryPaymentStore implements PaymentStore {
  private committed: Tables = { charges: [], refunds: [], paymentMethods: [] }

  get state(): Readonly<Tables> {
    return this.committed
  }

  async transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const working = clone(this.committed)
    const tx = makeTx(working)
    const result = await fn(tx) // a throw here leaves `committed` untouched
    this.committed = working
    return result
  }
}

function makeTx(t: Tables): PaymentTx {
  return {
    async insertChargeIfAbsent(row) {
      const clash = t.charges.some(
        (c) => c.provider === row.provider && c.externalId === row.externalId,
      )
      if (clash) return null
      const stored: ChargeRow = { ...row, metadata: { ...row.metadata } }
      t.charges.push(stored)
      return { ...stored }
    },
    async findChargeById(id) {
      return t.charges.find((c) => c.id === id) ?? null
    },
    async findChargeByExternalId(provider, externalId) {
      return t.charges.find((c) => c.provider === provider && c.externalId === externalId) ?? null
    },
    async listChargesForCustomer(customerId) {
      return t.charges.filter((c) => c.customerId === customerId)
    },
    async insertRefundIfAbsent(row) {
      const clash = t.refunds.some(
        (r) => r.provider === row.provider && r.externalId === row.externalId,
      )
      if (clash) return null
      const stored = { ...row }
      t.refunds.push(stored)
      return { ...stored }
    },
    async listRefundsForCharge(chargeId) {
      return t.refunds.filter((r) => r.chargeId === chargeId)
    },
    async listRefundsForCustomer(customerId) {
      const ids = new Set(t.charges.filter((c) => c.customerId === customerId).map((c) => c.id))
      return t.refunds.filter((r) => ids.has(r.chargeId))
    },
    async upsertPaymentMethod(row) {
      const idx = t.paymentMethods.findIndex(
        (p) => p.provider === row.provider && p.providerRef === row.providerRef,
      )
      if (idx === -1) {
        const stored = { ...row }
        t.paymentMethods.push(stored)
        return { ...stored }
      }
      const existing = t.paymentMethods[idx] as PaymentMethodRow
      const merged: PaymentMethodRow = {
        ...existing,
        brand: row.brand,
        last4: row.last4,
        expMonth: row.expMonth,
        expYear: row.expYear,
        isDefault: row.isDefault,
        detachedAt: null,
      }
      t.paymentMethods[idx] = merged
      return { ...merged }
    },
    async findPaymentMethodById(id) {
      return t.paymentMethods.find((p) => p.id === id) ?? null
    },
    async listPaymentMethods(customerId) {
      return t.paymentMethods.filter((p) => p.customerId === customerId && p.detachedAt === null)
    },
    async deletePaymentMethods(customerId) {
      const removed = t.paymentMethods.filter((p) => p.customerId === customerId)
      t.paymentMethods = t.paymentMethods.filter((p) => p.customerId !== customerId)
      return removed
    },
    async anonymiseCustomerCharges(customerId, anonymousId) {
      let count = 0
      t.charges = t.charges.map((c) => {
        if (c.customerId !== customerId) return c
        count += 1
        return { ...c, customerId: anonymousId, metadata: {} }
      })
      return count
    },
  }
}
