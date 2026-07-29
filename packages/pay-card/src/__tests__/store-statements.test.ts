import { describe, expect, it } from 'vitest'
import { SQL } from '../db/postgres.js'

/**
 * The in-memory store used by the other tests reproduces Postgres semantics, so
 * these assertions check that production actually asks Postgres for those
 * semantics — that the idempotency guarantee is a database constraint and not a
 * read-then-write race in application code.
 */

describe('production statements', () => {
  it('inserts a charge with ON CONFLICT DO NOTHING on the provider reference', () => {
    expect(SQL.insertCharge).toMatch(/ON CONFLICT \(provider, external_id\)\s+DO NOTHING/)
    expect(SQL.insertCharge).toMatch(/RETURNING \*/)
    // No SELECT-then-INSERT: the uniqueness decision is the database's.
    expect(SQL.insertCharge).not.toMatch(/SELECT/i)
  })

  it('inserts a refund with the same guarantee', () => {
    expect(SQL.insertRefund).toMatch(/ON CONFLICT \(provider, external_id\)\s+DO NOTHING/)
    expect(SQL.insertRefund).toMatch(/RETURNING \*/)
  })

  it('parameterises every statement rather than interpolating values', () => {
    for (const [name, statement] of Object.entries(SQL)) {
      // A quoted literal in a statement would mean a value was interpolated.
      const literals = statement.match(/'[^']*'/g) ?? []
      const allowed = literals.every((l) => l === "'{}'")
      expect(allowed, `${name} interpolates a literal: ${literals.join(', ')}`).toBe(true)
    }
  })

  it('touches only tables pay.card owns', () => {
    const owned = new Set(['charge', 'refund', 'payment_method'])
    const referenced = new Set<string>()
    for (const statement of Object.values(SQL)) {
      // `DO UPDATE SET` is the upsert conflict action, not a table reference —
      // fold it away first so the scan below sees only real table positions.
      const tablePositions = statement.replace(/\bDO\s+UPDATE\s+SET\b/gi, 'DO_UPDATE_SET')
      for (const m of tablePositions.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/g)) {
        referenced.add(m[1] as string)
      }
    }
    // Guards the scan itself: a regex that matched nothing would pass vacuously.
    expect([...referenced].sort()).toEqual(['charge', 'payment_method', 'refund'])
    for (const table of referenced) {
      expect(owned.has(table), `${table} is not owned by pay.card`).toBe(true)
    }
  })
})
