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
      for (const m of statement.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/g)) {
        referenced.add(m[1] as string)
      }
    }
    for (const table of referenced) {
      expect(owned.has(table), `${table} is not owned by pay.card`).toBe(true)
    }
  })
})
