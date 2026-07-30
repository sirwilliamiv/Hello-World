import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { charge } from '../charge.js'
import { assertNoCardData, isForbiddenFieldName, looksLikePan } from '../card-data-guard.js'
import { attachPaymentMethod } from '../payment-methods.js'
import { setupPayments } from '../testing/harness.js'

/**
 * Smoke test: "no column in any owned table accepts a PAN, and the provider
 * reference is opaque".
 *
 * The migration SQL is the authority on what the database can hold, so that is
 * what this test reads — not a TypeScript mirror of it.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, '..', '..', 'migrations')
const upSql = readFileSync(path.join(migrationsDir, '20260701_create_pay_card.up.sql'), 'utf8')

/** Column declarations, e.g. `  provider_ref text NOT NULL,`. */
function declaredColumns(sql: string): { table: string; column: string; type: string }[] {
  const out: { table: string; column: string; type: string }[] = []
  const tableRe = /CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g
  let match: RegExpExecArray | null
  while ((match = tableRe.exec(sql)) !== null) {
    const table = match[1] as string
    for (const rawLine of (match[2] as string).split('\n')) {
      const line = rawLine.replace(/--.*$/, '').trim()
      if (line.length === 0) continue
      if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)/i.test(line)) continue
      const cols = /^(\w+)\s+([\w()]+)/.exec(line)
      if (cols === null) continue
      out.push({ table, column: cols[1] as string, type: cols[2] as string })
    }
  }
  return out
}

describe('smoke: no card data is persisted', () => {
  const columns = declaredColumns(upSql)

  it('parses the migration into columns (guards the test itself)', () => {
    expect(columns.length).toBeGreaterThan(20)
    expect(columns.map((c) => c.table)).toContain('payment_method')
    expect(columns.map((c) => c.table)).toContain('charge')
    expect(columns.map((c) => c.table)).toContain('refund')
  })

  it('declares no column that could hold a PAN, CVC, or track data', () => {
    const offending = columns.filter((c) => isForbiddenFieldName(c.column))
    expect(offending).toEqual([])
  })

  it('bounds last4 to four digits at the database level', () => {
    expect(upSql).toMatch(/CHECK \(last4 IS NULL OR last4 ~ '\^\[0-9\]\{4\}\$'\)/)
  })

  it('stores only opaque provider references', async () => {
    const h = setupPayments()
    await charge(Money.of(4999, 'USD'), { id: 'user_1' })
    const stored = h.store.state.charges[0]
    expect(stored?.externalId).toMatch(/^pi_/)
    expect(looksLikePan(stored?.externalId ?? '')).toBe(false)

    await attachPaymentMethod({
      customerId: 'user_1',
      providerRef: 'pm_1NxTestHandle',
      providerCustomerId: 'cus_1',
    })
    const pm = h.store.state.paymentMethods[0]
    expect(pm?.providerRef).toMatch(/^pm_/)
    expect(pm?.last4).toBe('4242')
    expect(looksLikePan(pm?.providerRef ?? '')).toBe(false)
  })

  it('refuses a payment method reference that is a card number', async () => {
    setupPayments()
    await expect(
      attachPaymentMethod({ customerId: 'user_1', providerRef: '4242424242424242' }),
    ).rejects.toThrow(/pm_/)
  })

  it('refuses to write a record carrying a Luhn-valid card number', () => {
    expect(() => assertNoCardData({ note: '4242 4242 4242 4242' }, 'charge')).toThrow(
      /looks like a card number/,
    )
    expect(() => assertNoCardData({ metadata: { pan: 'x' } }, 'charge')).toThrow(/refusing to write/)
    // Opaque references and ordinary digits are not flagged.
    expect(() => assertNoCardData({ externalId: 'pi_3NxAbCdEf', last4: '4242' }, 'charge')).not.toThrow()
  })

  it('recognises a PAN only when it passes the Luhn check', () => {
    expect(looksLikePan('4242424242424242')).toBe(true)
    expect(looksLikePan('4242 4242 4242 4242')).toBe(true)
    expect(looksLikePan('1234567890123456')).toBe(false)
    expect(looksLikePan('pi_3NxAbCdEfGhIjKl')).toBe(false)
    expect(looksLikePan('4242')).toBe(false)
  })

  it('declares no card-data column in the Drizzle schema either', () => {
    const schema = readFileSync(path.resolve(here, '..', 'schema.ts'), 'utf8')
    const declared = [...schema.matchAll(/\b(?:text|bigint|smallint|integer|boolean|jsonb|timestamp)\('([^']+)'/g)]
      .map((m) => m[1] as string)
    expect(declared.length).toBeGreaterThan(20)
    expect(declared.filter(isForbiddenFieldName)).toEqual([])
  })
})
