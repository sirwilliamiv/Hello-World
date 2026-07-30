/**
 * Cross-currency conversion.
 *
 * Money arithmetic throws across currencies on purpose. This module is the only
 * sanctioned way to cross that line, and it requires an explicit ExchangeRate:
 * a conversion is a business event with a rate, a source, and a timestamp, not
 * an arithmetic convenience.
 *
 * ExchangeRate rows are append-only (see the capability spec) so that a
 * historical conversion stays reproducible after the rate changes.
 */

import { CurrencyMismatchError } from './errors.js'
import { getCurrency } from './currency.js'
import { Money, toSafeNumber } from './money.js'
import { DEFAULT_ROUNDING, divRound, rationalFromString, type RoundingMode } from './rational.js'

export interface ExchangeRate {
  /** Source currency code. */
  readonly from: string
  /** Target currency code. */
  readonly to: string
  /**
   * Major-unit rate as an exact decimal string: 1 `from` buys `rate` `to`.
   * A string rather than a number because a rate such as 1.10345 must survive
   * storage and re-reading without a float rounding it.
   */
  readonly rate: string
  /** When the rate was observed. Part of the append-only record. */
  readonly asOf: Date
  /** Where the rate came from, e.g. 'ecb' or 'manual'. */
  readonly source?: string
}

/**
 * Convert an amount using an explicit rate.
 *
 * The minor-unit exponents of the two currencies are applied as part of the same
 * exact rational computation, so converting USD (2dp) to JPY (0dp) does not go
 * through an intermediate float.
 */
export function convert(
  amount: Money,
  rate: ExchangeRate,
  rounding: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (amount.currency !== rate.from.toUpperCase()) {
    throw new CurrencyMismatchError(amount.currency, rate.from)
  }

  const fromExponent = getCurrency(amount.currency).minorUnits
  const toExponent = getCurrency(rate.to).minorUnits
  const r = rationalFromString(rate.rate)

  // minor_to = minor_from * rate * 10^(exp_to - exp_from)
  let numerator = BigInt(amount.amountMinor) * r.n
  let denominator = r.d
  const shift = toExponent - fromExponent
  if (shift > 0) numerator *= 10n ** BigInt(shift)
  else if (shift < 0) denominator *= 10n ** BigInt(-shift)

  return Money.of(toSafeNumber(divRound(numerator, denominator, rounding)), rate.to)
}

/** The inverse rate, exact to the given number of decimal places. */
export function invertRate(rate: ExchangeRate, decimals = 10): ExchangeRate {
  const r = rationalFromString(rate.rate)
  if (r.n === 0n) throw new RangeError('cannot invert a zero exchange rate')
  const scale = 10n ** BigInt(decimals)
  const inverted = divRound(r.d * scale, r.n, DEFAULT_ROUNDING)
  const text = inverted.toString().padStart(decimals + 1, '0')
  const cut = text.length - decimals
  return {
    from: rate.to,
    to: rate.from,
    rate: `${text.slice(0, cut)}.${text.slice(cut)}`,
    asOf: rate.asOf,
    ...(rate.source === undefined ? {} : { source: rate.source }),
  }
}
