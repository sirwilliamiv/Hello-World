import type {
  ChargeRow,
  PaymentMethodRow,
  PaymentStore,
  PaymentTx,
  RefundRow,
} from './port.js'
import type { ChargeStatus } from '../types.js'

/**
 * The production `PaymentStore`, backed by @forge/kernel-data's transaction
 * handle. Statements are parameterised and touch only pay.card's own three
 * tables, which is what the repository-layer allowlist derived from `owns`
 * requires (ARCHITECTURE.md section 9.3).
 *
 * kernel-data is imported dynamically so that a unit test which supplies its own
 * store never has to resolve it.
 */

interface KernelTx {
  execute<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>
}

interface KernelDataModule {
  transaction<T>(fn: (tx: KernelTx) => Promise<T>): Promise<T>
}

let kernelData: KernelDataModule | null = null

async function loadKernelData(): Promise<KernelDataModule> {
  kernelData ??= (await import('@forge/kernel-data')) as unknown as KernelDataModule
  return kernelData
}

/** Exposed for the statement-shape tests: production SQL is asserted, not guessed. */
export const SQL = {
  insertCharge: `
    INSERT INTO charge (
      id, customer_id, payment_method_id, amount_minor, currency, status, provider,
      external_id, invoice_id, statement_descriptor, failure_reason, decline_code,
      metadata, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (provider, external_id) DO NOTHING
    RETURNING *`,
  selectChargeById: 'SELECT * FROM charge WHERE id = $1',
  selectChargeByExternalId: 'SELECT * FROM charge WHERE provider = $1 AND external_id = $2',
  selectChargesForCustomer: 'SELECT * FROM charge WHERE customer_id = $1 ORDER BY created_at',
  insertRefund: `
    INSERT INTO refund (id, charge_id, amount_minor, currency, reason, provider, external_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (provider, external_id) DO NOTHING
    RETURNING *`,
  selectRefundsForCharge: 'SELECT * FROM refund WHERE charge_id = $1 ORDER BY created_at',
  selectRefundsForCustomer: `
    SELECT r.* FROM refund r
    JOIN charge c ON c.id = r.charge_id
    WHERE c.customer_id = $1
    ORDER BY r.created_at`,
  upsertPaymentMethod: `
    INSERT INTO payment_method (
      id, customer_id, provider, provider_ref, brand, last4, exp_month, exp_year,
      is_default, created_at, detached_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (provider, provider_ref)
    DO UPDATE SET brand = EXCLUDED.brand,
                  last4 = EXCLUDED.last4,
                  exp_month = EXCLUDED.exp_month,
                  exp_year = EXCLUDED.exp_year,
                  is_default = EXCLUDED.is_default,
                  detached_at = NULL
    RETURNING *`,
  selectPaymentMethodById: 'SELECT * FROM payment_method WHERE id = $1',
  selectPaymentMethods:
    'SELECT * FROM payment_method WHERE customer_id = $1 AND detached_at IS NULL ORDER BY created_at',
  deletePaymentMethods: 'DELETE FROM payment_method WHERE customer_id = $1 RETURNING *',
  // Charge and Refund are append-only. Anonymisation is the single sanctioned
  // mutation, and it rewrites the subject reference only — never the amounts.
  anonymiseCharges: `
    UPDATE charge
       SET customer_id = $2, metadata = '{}'::jsonb
     WHERE customer_id = $1`,
} as const

function toChargeRow(raw: Record<string, unknown>): ChargeRow {
  return {
    id: String(raw['id']),
    customerId: String(raw['customer_id']),
    paymentMethodId: raw['payment_method_id'] === null ? null : String(raw['payment_method_id']),
    amountMinor: Number(raw['amount_minor']),
    currency: String(raw['currency']),
    status: String(raw['status']) as ChargeStatus,
    provider: String(raw['provider']),
    externalId: String(raw['external_id']),
    invoiceId: raw['invoice_id'] === null ? null : String(raw['invoice_id']),
    statementDescriptor:
      raw['statement_descriptor'] === null ? null : String(raw['statement_descriptor']),
    failureReason: raw['failure_reason'] === null ? null : String(raw['failure_reason']),
    declineCode: raw['decline_code'] === null ? null : String(raw['decline_code']),
    metadata: (raw['metadata'] ?? {}) as Record<string, string>,
    createdAt: new Date(String(raw['created_at'])),
  }
}

function toRefundRow(raw: Record<string, unknown>): RefundRow {
  return {
    id: String(raw['id']),
    chargeId: String(raw['charge_id']),
    amountMinor: Number(raw['amount_minor']),
    currency: String(raw['currency']),
    reason: raw['reason'] === null ? null : String(raw['reason']),
    provider: String(raw['provider']),
    externalId: String(raw['external_id']),
    createdAt: new Date(String(raw['created_at'])),
  }
}

function toPaymentMethodRow(raw: Record<string, unknown>): PaymentMethodRow {
  return {
    id: String(raw['id']),
    customerId: String(raw['customer_id']),
    provider: String(raw['provider']),
    providerRef: String(raw['provider_ref']),
    brand: raw['brand'] === null ? null : String(raw['brand']),
    last4: raw['last4'] === null ? null : String(raw['last4']),
    expMonth: raw['exp_month'] === null ? null : Number(raw['exp_month']),
    expYear: raw['exp_year'] === null ? null : Number(raw['exp_year']),
    isDefault: Boolean(raw['is_default']),
    createdAt: new Date(String(raw['created_at'])),
    detachedAt: raw['detached_at'] === null ? null : new Date(String(raw['detached_at'])),
  }
}

function makeTx(tx: KernelTx): PaymentTx {
  const one = <T>(rows: Record<string, unknown>[], map: (r: Record<string, unknown>) => T): T | null =>
    rows.length === 0 || rows[0] === undefined ? null : map(rows[0])

  return {
    async insertChargeIfAbsent(row) {
      const rows = await tx.execute(SQL.insertCharge, [
        row.id,
        row.customerId,
        row.paymentMethodId,
        row.amountMinor,
        row.currency,
        row.status,
        row.provider,
        row.externalId,
        row.invoiceId,
        row.statementDescriptor,
        row.failureReason,
        row.declineCode,
        JSON.stringify(row.metadata),
        row.createdAt,
      ])
      return one(rows, toChargeRow)
    },
    async findChargeById(id) {
      return one(await tx.execute(SQL.selectChargeById, [id]), toChargeRow)
    },
    async findChargeByExternalId(provider, externalId) {
      return one(await tx.execute(SQL.selectChargeByExternalId, [provider, externalId]), toChargeRow)
    },
    async listChargesForCustomer(customerId) {
      return (await tx.execute(SQL.selectChargesForCustomer, [customerId])).map(toChargeRow)
    },
    async insertRefundIfAbsent(row) {
      const rows = await tx.execute(SQL.insertRefund, [
        row.id,
        row.chargeId,
        row.amountMinor,
        row.currency,
        row.reason,
        row.provider,
        row.externalId,
        row.createdAt,
      ])
      return one(rows, toRefundRow)
    },
    async listRefundsForCharge(chargeId) {
      return (await tx.execute(SQL.selectRefundsForCharge, [chargeId])).map(toRefundRow)
    },
    async listRefundsForCustomer(customerId) {
      return (await tx.execute(SQL.selectRefundsForCustomer, [customerId])).map(toRefundRow)
    },
    async upsertPaymentMethod(row) {
      const rows = await tx.execute(SQL.upsertPaymentMethod, [
        row.id,
        row.customerId,
        row.provider,
        row.providerRef,
        row.brand,
        row.last4,
        row.expMonth,
        row.expYear,
        row.isDefault,
        row.createdAt,
        row.detachedAt,
      ])
      const mapped = one(rows, toPaymentMethodRow)
      if (mapped === null) throw new Error('upsertPaymentMethod returned no row')
      return mapped
    },
    async findPaymentMethodById(id) {
      return one(await tx.execute(SQL.selectPaymentMethodById, [id]), toPaymentMethodRow)
    },
    async listPaymentMethods(customerId) {
      return (await tx.execute(SQL.selectPaymentMethods, [customerId])).map(toPaymentMethodRow)
    },
    async deletePaymentMethods(customerId) {
      return (await tx.execute(SQL.deletePaymentMethods, [customerId])).map(toPaymentMethodRow)
    },
    async anonymiseCustomerCharges(customerId, anonymousId) {
      const rows = await tx.execute(SQL.anonymiseCharges, [customerId, anonymousId])
      return rows.length
    },
  }
}

export function createPostgresStore(): PaymentStore {
  return {
    async transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
      const kd = await loadKernelData()
      return kd.transaction((tx) => fn(makeTx(tx)))
    },
  }
}
