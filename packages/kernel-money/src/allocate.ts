/**
 * Splitting an amount without losing or inventing minor units.
 *
 * This is the single most-copied piece of money code in any product that has
 * split payouts, proportional tax, or instalment plans, and the copies are
 * almost always wrong: they round each part independently and then discover
 * that the parts do not sum to the total.
 *
 * The contract here is exact and unconditional:
 *
 *     sum(allocate(total, ratios)) === total     // for every total, every ratio set
 *
 * The remainder is distributed by the largest-remainder method, ties broken by
 * position, so the result is deterministic: the same inputs always produce the
 * same split, on every machine and every run. That determinism is what lets a
 * payout reconcile against a re-computation months later.
 */

import { AllocationError } from './errors.js'
import { Money, toRational, toSafeNumber } from './money.js'
import { abs, lcm } from './rational.js'

export type Ratio = number | string

/**
 * Split `total` across `ratios`, preserving the total exactly.
 *
 * Ratios need not sum to anything in particular — [1, 1, 1] and [2, 2, 2] give
 * the same split, and [0.7, 0.3] behaves like [7, 3]. Negative ratios are
 * rejected: a negative share is a modelling error, not a refund.
 */
export function allocate(total: Money, ratios: readonly Ratio[]): Money[] {
  if (ratios.length === 0) {
    throw new AllocationError('allocate requires at least one ratio')
  }

  const rationals = ratios.map((ratio, index) => {
    const r = toRational(ratio)
    if (r.n < 0n) {
      throw new AllocationError(
        `ratio at index ${index} is negative (${String(ratio)}): allocation ratios must be zero or positive`,
      )
    }
    return r
  })

  // Put every ratio over a common denominator so the weights are exact integers.
  const denominator = rationals.reduce<bigint>((acc, r) => lcm(acc, r.d), 1n)
  const weights = rationals.map((r) => r.n * (denominator / r.d))
  const totalWeight = weights.reduce<bigint>((acc, w) => acc + w, 0n)
  if (totalWeight === 0n) {
    throw new AllocationError('allocation ratios sum to zero: nothing to allocate against')
  }

  // Work on the magnitude and re-apply the sign, so that a negative total
  // (a refund, a credit note) splits as the mirror image of its positive twin
  // rather than drifting by a minor unit in the other direction.
  const signed = BigInt(total.amountMinor)
  const negative = signed < 0n
  const magnitude = abs(signed)

  const parts = weights.map((weight, index) => {
    const scaled = magnitude * weight
    return {
      index,
      base: scaled / totalWeight,
      remainder: scaled % totalWeight,
    }
  })

  const distributed = parts.reduce<bigint>((acc, part) => acc + part.base, 0n)
  let leftover = magnitude - distributed

  // Largest remainder first; ties go to the earlier position. Deterministic.
  const order = [...parts].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index
    return a.remainder > b.remainder ? -1 : 1
  })

  const extra = new Map<number, bigint>()
  for (const part of order) {
    if (leftover <= 0n) break
    extra.set(part.index, 1n)
    leftover -= 1n
  }

  return parts.map((part) => {
    const amount = part.base + (extra.get(part.index) ?? 0n)
    return Money.of(toSafeNumber(negative ? -amount : amount), total.currency)
  })
}

/** `allocate(total, [1, 1, ... n times])`. The common "split evenly" case. */
export function allocateEvenly(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new AllocationError(`cannot split into ${String(parts)} parts`)
  }
  return allocate(total, new Array<number>(parts).fill(1))
}

/**
 * Exposed for the money smoke test and for capabilities that want to assert the
 * invariant in their own tests.
 */
export function allocationPreservesTotal(total: Money, allocated: readonly Money[]): boolean {
  const sum = allocated.reduce<bigint>((acc, part) => {
    if (part.currency !== total.currency) return acc
    return acc + BigInt(part.amountMinor)
  }, 0n)
  return sum === BigInt(total.amountMinor)
}
