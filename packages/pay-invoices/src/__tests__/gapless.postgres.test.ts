import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SQL } from '../db/postgres.js'

/**
 * The gaplessness proof against a REAL Postgres.
 *
 * The rest of the suite runs against an in-memory store that reproduces row
 * locking and rollback. That store is written to be faithful, but a store the
 * same author wrote cannot by itself prove the SQL is right — so this test runs
 * `SQL.allocateSequence` against an actual server when one is available.
 *
 * Skipped unless DATABASE_URL is set and the `postgres` driver resolves (it is a
 * dependency of the generated product, not of this package). CI for the catalog
 * snapshot should set both.
 */

const databaseUrl = process.env['DATABASE_URL']

interface Sql {
  unsafe(query: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  end(): Promise<void>
}

let sql: Sql | null = null
const here = path.dirname(fileURLToPath(import.meta.url))
const upSql = readFileSync(
  path.resolve(here, '..', '..', 'migrations', '20260701_create_pay_invoices.up.sql'),
  'utf8',
)
const downSql = readFileSync(
  path.resolve(here, '..', '..', 'migrations', '20260701_create_pay_invoices.down.sql'),
  'utf8',
)

async function connect(): Promise<Sql | null> {
  if (databaseUrl === undefined) return null
  try {
    const mod = (await import('postgres')) as unknown as {
      default: (url: string, opts?: Record<string, unknown>) => Sql
    }
    return mod.default(databaseUrl, { max: 20 })
  } catch {
    return null
  }
}

const enabled = databaseUrl !== undefined

describe.skipIf(!enabled)('gapless numbering against a real Postgres', () => {
  beforeAll(async () => {
    sql = await connect()
    if (sql === null) return
    await sql.unsafe(downSql)
    await sql.unsafe(upSql)
  })

  afterAll(async () => {
    if (sql === null) return
    await sql.unsafe(downSql)
    await sql.end()
  })

  it('100 concurrent transactions allocate 1..100 with no gaps and no duplicates', async () => {
    if (sql === null) return
    const db = sql

    const allocated = await Promise.all(
      Array.from({ length: 100 }, () =>
        db.begin(async (tx) => {
          const rows = await tx.unsafe(SQL.allocateSequence, ['Acme Trading Ltd', '2026'])
          // Hold the transaction open, so the row lock is genuinely contended.
          await tx.unsafe('SELECT pg_sleep(0.01)')
          return Number(rows[0]?.['last_value'])
        }),
      ),
    )

    expect(new Set(allocated).size).toBe(100)
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    )
  }, 60_000)

  it('a rolled-back transaction returns its number rather than burning it', async () => {
    if (sql === null) return
    const db = sql

    const before = await db.unsafe(SQL.peekSequence, ['Rollback Ltd', '2026'])
    expect(before[0]).toBeUndefined()

    await db.begin(async (tx) => {
      await tx.unsafe(SQL.allocateSequence, ['Rollback Ltd', '2026'])
    })
    const afterCommit = await db.unsafe(SQL.peekSequence, ['Rollback Ltd', '2026'])
    expect(Number(afterCommit[0]?.['last_value'])).toBe(1)

    await expect(
      db.begin(async (tx) => {
        await tx.unsafe(SQL.allocateSequence, ['Rollback Ltd', '2026'])
        throw new Error('deliberate failure after allocation')
      }),
    ).rejects.toThrow(/deliberate failure/)

    const afterRollback = await db.unsafe(SQL.peekSequence, ['Rollback Ltd', '2026'])
    expect(Number(afterRollback[0]?.['last_value'])).toBe(1)
  }, 30_000)

  it('the unique index rejects a duplicate number and a duplicate receipt', async () => {
    if (sql === null) return
    const db = sql
    const base = [
      'inv_a',
      'Dup Ltd',
      '2026',
      1,
      'INV-2026-00001',
      'user_1',
      'USD',
      100,
      0,
      100,
      0,
      0,
      'open',
      new Date(),
      new Date(),
      null,
      null,
      null,
      '{}',
    ]
    await db.unsafe(SQL.insertInvoice, base)
    await expect(db.unsafe(SQL.insertInvoice, ['inv_b', ...base.slice(1)])).rejects.toThrow(
      /invoice_number_key/,
    )

    const receipt = ['rcp_a', 'inv_a', 'chg_1', 100, 'USD', new Date(), null]
    const first = await db.unsafe(SQL.insertReceipt, receipt)
    expect(first).toHaveLength(1)
    const second = await db.unsafe(SQL.insertReceipt, ['rcp_b', ...receipt.slice(1)])
    expect(second).toHaveLength(0) // ON CONFLICT DO NOTHING: applied exactly once
  }, 30_000)
})
