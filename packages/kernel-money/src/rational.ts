/**
 * Exact rational arithmetic over bigint.
 *
 * This module exists so that no money computation ever touches a float. A
 * multiplier such as a 7.25% tax rate arrives as a JavaScript number, but it is
 * converted to an exact rational (29 / 400) before it is applied to an amount,
 * and the division back to minor units is done with an explicit rounding mode.
 *
 * Internal to @forge/kernel-money. The public surface is Money and allocate().
 */

import { MoneyError } from './errors.js'

export interface Rational {
  /** Numerator. Carries the sign. */
  readonly n: bigint
  /** Denominator. Always > 0. */
  readonly d: bigint
}

/**
 * How a division that does not land on a whole minor unit is resolved.
 *
 * `half_even` (banker's rounding) is the default everywhere in this package: it
 * is the only half-mode that does not accumulate a systematic bias across a
 * large number of roundings, which is what makes long-running ledgers reconcile.
 */
export type RoundingMode =
  | 'half_even'
  | 'half_up'
  | 'half_down'
  | 'up'
  | 'down'
  | 'ceil'
  | 'floor'

export const DEFAULT_ROUNDING: RoundingMode = 'half_even'

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/**
 * Parse an exact decimal string into a rational. No precision is lost: "0.1"
 * becomes 1/10, not the double nearest to a tenth.
 */
export function rationalFromString(text: string): Rational {
  const match = DECIMAL.exec(text.trim())
  if (match === null) throw new MoneyError(`not a decimal number: ${JSON.stringify(text)}`)

  const sign = match[1] === '-' ? -1n : 1n
  const intPart = match[2] ?? ''
  const fracPart = match[3] ?? ''
  const expPart = match[4] ?? '0'
  if (intPart === '' && fracPart === '') {
    throw new MoneyError(`not a decimal number: ${JSON.stringify(text)}`)
  }

  let n = BigInt(`${intPart === '' ? '0' : intPart}${fracPart}`) * sign
  let d = 10n ** BigInt(fracPart.length)

  const exponent = BigInt(expPart)
  if (exponent > 0n) n *= 10n ** exponent
  else if (exponent < 0n) d *= 10n ** -exponent

  return normalize({ n, d })
}

/**
 * Convert a JavaScript number to a rational via its shortest round-tripping
 * decimal representation. `0.1` therefore becomes exactly 1/10 rather than the
 * binary approximation, which is the behaviour every accountant expects when
 * they write a rate as 0.1 in a manifest.
 */
export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new MoneyError(`not a finite number: ${String(value)}`)
  return rationalFromString(value.toString())
}

export function rationalMultiply(a: Rational, b: Rational): Rational {
  return normalize({ n: a.n * b.n, d: a.d * b.d })
}

export function normalize(r: Rational): Rational {
  if (r.d === 0n) throw new MoneyError('rational with zero denominator')
  const sign = r.d < 0n ? -1n : 1n
  const n = r.n * sign
  const d = r.d * sign
  const g = gcd(abs(n), d)
  return g > 1n ? { n: n / g, d: d / g } : { n, d }
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a)
  let y = abs(b)
  while (y !== 0n) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n
  return abs(a / gcd(a, b)) * abs(b)
}

export function abs(v: bigint): bigint {
  return v < 0n ? -v : v
}

/**
 * Integer division with an explicit rounding mode. This is the single place
 * where a fractional minor unit is resolved into a whole one.
 */
export function divRound(num: bigint, den: bigint, mode: RoundingMode = DEFAULT_ROUNDING): bigint {
  if (den === 0n) throw new MoneyError('division by zero')

  const negative = num < 0n !== den < 0n
  const a = abs(num)
  const b = abs(den)
  const q = a / b
  const r = a % b
  if (r === 0n) return negative ? -q : q

  const twice = r * 2n
  let increment: boolean
  switch (mode) {
    case 'down':
      increment = false
      break
    case 'up':
      increment = true
      break
    case 'ceil':
      increment = !negative
      break
    case 'floor':
      increment = negative
      break
    case 'half_up':
      increment = twice >= b
      break
    case 'half_down':
      increment = twice > b
      break
    case 'half_even':
      increment = twice > b || (twice === b && q % 2n === 1n)
      break
  }

  const magnitude = increment ? q + 1n : q
  return negative ? -magnitude : magnitude
}
