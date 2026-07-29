import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { issue } from '../invoice.js'
import { InvalidNumberingSchemeError, formatInvoiceNumber, parseNumberingScheme, periodKey } from '../numbering.js'
import { configureInvoices, __resetInvoicesForTests } from '../config.js'
import { SQL } from '../db/postgres.js'
import { MemoryInvoiceStore } from '../testing/memory-store.js'
import { LEGAL_ENTITY, setupInvoices } from '../testing/harness.js'

const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

describe('numbering scheme validation', () => {
  it('rejects a scheme with no {SEQ:n} token, because it cannot be gapless', () => {
    expect(() => parseNumberingScheme('INV-{YYYY}')).toThrow(InvalidNumberingSchemeError)
    expect(() => parseNumberingScheme('INV-{YYYY}')).toThrow(/cannot be gapless/)
  })

  it('rejects an unknown token', () => {
    expect(() => parseNumberingScheme('INV-{QUARTER}-{SEQ:4}')).toThrow(/unknown token/)
  })

  it('rejects more than one sequence token and an out-of-range width', () => {
    expect(() => parseNumberingScheme('{SEQ:3}-{SEQ:3}')).toThrow(/more than one/)
    expect(() => parseNumberingScheme('{SEQ:0}')).toThrow(/padding/)
    expect(() => parseNumberingScheme('{SEQ:13}')).toThrow(/padding/)
  })

  it('is rejected at configure time, not at first issue', () => {
    __resetInvoicesForTests()
    expect(() =>
      configureInvoices({ legalEntity: LEGAL_ENTITY, numberingScheme: 'INV-{YYYY}' }),
    ).toThrow(InvalidNumberingSchemeError)
  })

  it('derives the reset period from the tokens present', () => {
    expect(parseNumberingScheme('INV-{YYYY}-{MM}-{SEQ:4}').resetPeriod).toBe('month')
    expect(parseNumberingScheme('INV-{YYYY}-{SEQ:4}').resetPeriod).toBe('year')
    expect(parseNumberingScheme('INV-{SEQ:6}').resetPeriod).toBe('never')

    const at = new Date('2026-03-09T00:00:00Z')
    expect(periodKey(parseNumberingScheme('{YYYY}-{MM}-{SEQ:4}'), at)).toBe('2026-03')
    expect(periodKey(parseNumberingScheme('{YYYY}-{SEQ:4}'), at)).toBe('2026')
    expect(periodKey(parseNumberingScheme('{SEQ:4}'), at)).toBe('ALL')
  })

  it('substitutes every token', () => {
    const at = new Date('2026-03-09T00:00:00Z')
    expect(formatInvoiceNumber(parseNumberingScheme('INV-{YYYY}-{SEQ:5}'), 42, at)).toBe(
      'INV-2026-00042',
    )
    expect(formatInvoiceNumber(parseNumberingScheme('{YY}{MM}-{SEQ:3}'), 7, at)).toBe('2603-007')
  })
})

describe('smoke: numbering is gapless under concurrency', () => {
  it('100 concurrent issues produce 100 consecutive numbers with no gaps and no duplicates', async () => {
    const h = await setupInvoices()

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        issue({ customerId: `user_${i}`, lines: [line(1000 + i)] }),
      ),
    )

    const numbers = results.map((r) => r.number).sort()
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b)

    // No duplicates.
    expect(new Set(numbers).size).toBe(100)
    expect(new Set(sequences).size).toBe(100)

    // No gaps: exactly 1..100, consecutive.
    expect(sequences).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(numbers).toEqual(
      Array.from({ length: 100 }, (_, i) => `INV-2026-${String(i + 1).padStart(5, '0')}`),
    )

    // The counter agrees with what was issued.
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(100)
    expect(h.store.state.invoices).toHaveLength(100)

    // And the concurrency was real: transactions had to queue on the row lock.
    expect(h.store.stats.sequenceLockWaits).toBeGreaterThan(0)
  })

  it('keeps sequences independent per legal entity', async () => {
    const h = await setupInvoices()

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () =>
        issue({ customerId: 'u', legalEntity: 'Entity A', lines: [line(100)] }),
      ),
      ...Array.from({ length: 20 }, () =>
        issue({ customerId: 'u', legalEntity: 'Entity B', lines: [line(100)] }),
      ),
    ])

    const a = results.filter((r) => r.legalEntity === 'Entity A').map((r) => r.sequence).sort((x, y) => x - y)
    const b = results.filter((r) => r.legalEntity === 'Entity B').map((r) => r.sequence).sort((x, y) => x - y)

    expect(a).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(b).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(h.store.sequenceValue('Entity A', '2026')).toBe(20)
    expect(h.store.sequenceValue('Entity B', '2026')).toBe(20)
  })

  it('restarts the sequence when the scheme embeds a period that has rolled over', async () => {
    let now = new Date('2026-12-31T23:00:00.000Z')
    const h = await setupInvoices({ numberingScheme: 'INV-{YYYY}-{MM}-{SEQ:4}', clock: () => now })

    const a = await issue({ customerId: 'u', lines: [line(100)] })
    const b = await issue({ customerId: 'u', lines: [line(100)] })
    now = new Date('2027-01-01T01:00:00.000Z')
    const c = await issue({ customerId: 'u', lines: [line(100)] })

    expect(a.number).toBe('INV-2026-12-0001')
    expect(b.number).toBe('INV-2026-12-0002')
    expect(c.number).toBe('INV-2027-01-0001')
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026-12')).toBe(2)
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2027-01')).toBe(1)
  })
})

describe('smoke: a rolled-back insert does not burn a number', () => {
  it('leaves the sequence unchanged when the insert violates a unique constraint', async () => {
    // A slot that always returns the same number: the first insert succeeds and
    // the second violates invoice_number_key AFTER the number was allocated.
    const h = await setupInvoices({ slots: { numberingScheme: () => 'INV-2026-00001' } })

    const first = await issue({ customerId: 'u', lines: [line(100)] })
    expect(first.number).toBe('INV-2026-00001')
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(1)

    await expect(issue({ customerId: 'u', lines: [line(100)] })).rejects.toThrow(
      /invoice_number_key/,
    )

    // The rolled-back transaction returned its number rather than burning it.
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(1)
    expect(h.store.state.invoices).toHaveLength(1)
    expect(h.store.stats.rollbacks).toBe(1)
  })

  it('leaves the sequence unchanged when a slot throws after allocation', async () => {
    const h = await setupInvoices({
      slots: {
        numberingScheme: () => {
          throw new Error('client numbering service unavailable')
        },
      },
    })

    await expect(issue({ customerId: 'u', lines: [line(100)] })).rejects.toThrow(/unavailable/)

    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(0)
    expect(h.store.state.invoices).toHaveLength(0)
  })

  it('still issues consecutively after failures, so the ledger has no hole', async () => {
    let attempt = 0
    const h = await setupInvoices({
      slots: {
        numberingScheme: (ctx) => {
          attempt += 1
          // Every second attempt fails after its number has been allocated.
          if (attempt % 2 === 0) throw new Error('transient failure')
          return ctx.defaultNumber()
        },
      },
    })

    const numbers: string[] = []
    for (let i = 0; i < 6; i += 1) {
      try {
        numbers.push((await issue({ customerId: 'u', lines: [line(100)] })).number)
      } catch {
        /* rolled back */
      }
    }

    expect(numbers).toEqual(['INV-2026-00001', 'INV-2026-00002', 'INV-2026-00003'])
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(3)
    expect(h.store.stats.rollbacks).toBe(3)
  })
})

describe('the allocation is a single atomic statement', () => {
  it('increments and returns in one statement holding a row lock', () => {
    expect(SQL.allocateSequence).toMatch(/INSERT INTO invoice_sequence/)
    expect(SQL.allocateSequence).toMatch(/ON CONFLICT \(legal_entity, period\)/)
    expect(SQL.allocateSequence).toMatch(/DO UPDATE SET last_value = invoice_sequence\.last_value \+ 1/)
    expect(SQL.allocateSequence).toMatch(/RETURNING last_value/)
    // No read-then-write: there is no window for two transactions to race.
    expect(SQL.allocateSequence).not.toMatch(/SELECT/i)
  })

  it('never uses a Postgres SEQUENCE, which would not roll back', () => {
    const statements = Object.values(SQL).join('\n')
    expect(statements).not.toMatch(/nextval/i)
    expect(statements).not.toMatch(/CREATE SEQUENCE/i)
  })
})

describe('the numberingScheme slot cannot break gaplessness', () => {
  it('receives the allocated sequence and can only format it', async () => {
    const seen: number[] = []
    const h = await setupInvoices({
      slots: {
        numberingScheme: (ctx) => {
          seen.push(ctx.sequence)
          return `ACME/${ctx.legalEntity.slice(0, 1)}/${String(ctx.sequence).padStart(6, '0')}`
        },
      },
    })

    const results = await Promise.all(
      Array.from({ length: 25 }, () => issue({ customerId: 'u', lines: [line(100)] })),
    )

    expect(seen.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(new Set(results.map((r) => r.number)).size).toBe(25)
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(25)
  })

  it('is rejected when it returns an empty string', async () => {
    await setupInvoices({ slots: { numberingScheme: () => '   ' } })
    await expect(issue({ customerId: 'u', lines: [line(100)] })).rejects.toThrow(/non-empty string/)
  })
})

describe('the store itself behaves like Postgres', () => {
  it('serialises concurrent allocations on the counter row', async () => {
    const store = new MemoryInvoiceStore()
    const observed: number[] = []

    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.transaction(async (tx) => {
          const n = await tx.allocateInvoiceNumber('E', '2026')
          // Yield inside the transaction: without a lock held to the end of the
          // transaction, another allocation would interleave here.
          await new Promise((r) => setTimeout(r, 0))
          observed.push(n)
        }),
      ),
    )

    expect(observed.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    )
  })

  it('rolls an allocation back when the transaction throws', async () => {
    const store = new MemoryInvoiceStore()
    await store.transaction((tx) => tx.allocateInvoiceNumber('E', '2026'))
    await expect(
      store.transaction(async (tx) => {
        await tx.allocateInvoiceNumber('E', '2026')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(store.sequenceValue('E', '2026')).toBe(1)
  })
})

describe('smoke: invoice issues and renders', () => {
  it('produces a numbered record and a rendered document', async () => {
    const h = await setupInvoices()
    const invoice = await issue({
      customerId: 'user_1',
      lines: [
        { description: 'Design retainer', unitAmount: Money.of(150_000, 'USD') },
        { description: 'Hosting', quantityMilli: 2500, unitAmount: Money.of(3333, 'USD') },
      ],
    })

    expect(invoice.number).toBe('INV-2026-00001')
    expect(invoice.sequence).toBe(1)
    expect(invoice.status).toBe('open')
    expect(invoice.lines).toHaveLength(2)
    // 3333 x 2.5 = 8332.5, rounded half-up to 8333 minor units. No float.
    expect(invoice.lines[1]?.amount.amountMinor).toBe(8333)
    expect(invoice.total.amountMinor).toBe(158_333)
    expect(invoice.dueAt.toISOString()).toBe('2026-07-31T09:00:00.000Z')

    // docs.generation numbers template versions from 1; the rendering pins it.
    expect(h.docs.renderCount()).toBe(1)
    expect(invoice.documentTemplateVersion).toBe('1')
    expect(h.store.state.invoices[0]?.documentTemplateVersion).toBe('1')
  })
})
