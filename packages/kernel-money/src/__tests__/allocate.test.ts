/**
 * Smoke test: "allocation preserves the total".
 *
 * The spec's assertion is universally quantified — "for any total and any ratio
 * set" — so the test is a property check over a deterministically seeded sample
 * rather than a handful of examples. The seed is fixed: a failure here must be
 * reproducible, because a nondeterministic money test is worse than none.
 */

import { describe, expect, it } from 'vitest'

import { allocate, allocateEvenly, allocationPreservesTotal } from '../allocate.js'
import { Money } from '../money.js'

/** Deterministic 32-bit PRNG (mulberry32). No clock, no Math.random. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function totalOf(parts: readonly Money[]): number {
  return parts.reduce((acc, part) => acc + part.amountMinor, 0)
}

describe('allocate', () => {
  it('preserves the total for every generated total and ratio set', () => {
    const random = seeded(20260729)

    for (let round = 0; round < 2000; round += 1) {
      const magnitude = Math.floor(random() * 1_000_000)
      const total = Money.of(random() < 0.2 ? -magnitude : magnitude, 'USD')
      const partCount = 1 + Math.floor(random() * 8)
      const ratios = Array.from({ length: partCount }, () =>
        // A mix of integers, decimals and the occasional zero share.
        random() < 0.15 ? 0 : Math.round(random() * 10000) / 100,
      )
      if (ratios.every((r) => r === 0)) continue

      const parts = allocate(total, ratios)

      expect(parts).toHaveLength(partCount)
      expect(totalOf(parts)).toBe(total.amountMinor)
      expect(allocationPreservesTotal(total, parts)).toBe(true)
      for (const part of parts) expect(part.currency).toBe('USD')
    }
  })

  it('distributes the remainder to the largest remainders, earliest position first', () => {
    // The canonical example: 5 cents three ways.
    expect(allocate(Money.of(5, 'USD'), [1, 1, 1]).map((m) => m.amountMinor)).toEqual([2, 2, 1])
    // 100 split 1:1:1 leaves one cent over, which goes to the first part.
    expect(allocateEvenly(Money.of(100, 'USD'), 3).map((m) => m.amountMinor)).toEqual([34, 33, 33])
  })

  it('is deterministic: the same inputs always produce the same split', () => {
    const first = allocate(Money.of(1_000_003, 'USD'), [3, 5, 7, 11])
    const second = allocate(Money.of(1_000_003, 'USD'), [3, 5, 7, 11])
    expect(first.map((m) => m.amountMinor)).toEqual(second.map((m) => m.amountMinor))
  })

  it('splits a negative total as the mirror image of the positive one', () => {
    const positive = allocate(Money.of(5, 'USD'), [1, 1, 1]).map((m) => m.amountMinor)
    const negative = allocate(Money.of(-5, 'USD'), [1, 1, 1]).map((m) => m.amountMinor)
    expect(negative).toEqual(positive.map((v) => -v))
    expect(totalOf(allocate(Money.of(-5, 'USD'), [1, 1, 1]))).toBe(-5)
  })

  it('treats proportional ratios identically however they are scaled', () => {
    const a = allocate(Money.of(9999, 'USD'), [1, 3]).map((m) => m.amountMinor)
    const b = allocate(Money.of(9999, 'USD'), [0.25, 0.75]).map((m) => m.amountMinor)
    const c = allocate(Money.of(9999, 'USD'), [25, 75]).map((m) => m.amountMinor)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('gives a zero-ratio part nothing', () => {
    expect(allocate(Money.of(101, 'USD'), [1, 0, 1]).map((m) => m.amountMinor)).toEqual([51, 0, 50])
  })

  it('rejects ratio sets it cannot split deterministically', () => {
    expect(() => allocate(Money.of(100, 'USD'), [])).toThrow(/at least one ratio/)
    expect(() => allocate(Money.of(100, 'USD'), [0, 0])).toThrow(/sum to zero/)
    expect(() => allocate(Money.of(100, 'USD'), [1, -1])).toThrow(/negative/)
  })
})
