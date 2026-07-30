/**
 * Money: an integer amount in minor units plus a currency.
 *
 * The shared money primitive. Only the kernel may define it, and every
 * capability that handles money uses this type rather than a number.
 *
 * Rules the type enforces, because convention does not survive twenty client
 * repositories:
 *   - amounts are whole minor units, always (cents, not dollars);
 *   - arithmetic between different currencies throws, it never coerces;
 *   - any operation that could produce a fraction of a minor unit takes an
 *     explicit rounding mode and resolves it with exact integer arithmetic.
 */

import { CurrencyMismatchError, MoneyPrecisionError } from './errors.js'
import { getCurrency, minorUnitScale } from './currency.js'
import {
  DEFAULT_ROUNDING,
  divRound,
  rationalFromNumber,
  rationalFromString,
  type Rational,
  type RoundingMode,
} from './rational.js'

/** The wire / storage form of a Money value. */
export interface MoneyJSON {
  readonly amountMinor: number
  readonly currency: string
}

export interface MoneyFormatOptions {
  /** BCP 47 locale. Defaults to the runtime locale. */
  readonly locale?: string
  /** 'symbol' (default) → "$12.34", 'code' → "USD 12.34", 'none' → "12.34". */
  readonly display?: 'symbol' | 'code' | 'none'
}

/**
 * A multiplier. Numbers are converted to exact rationals via their decimal
 * representation, so `0.1` means one tenth and not the nearest double.
 * A decimal string is accepted for factors that a double cannot represent
 * exactly at all.
 */
export type Factor = number | string

export class Money {
  /** Whole minor units. Always a safe integer. */
  readonly amountMinor: number
  /** ISO 4217 alphabetic code, uppercase. */
  readonly currency: string

  private constructor(amountMinor: number, currency: string) {
    this.amountMinor = amountMinor
    this.currency = currency
    Object.freeze(this)
  }

  /**
   * The only constructor. `minor` is minor units — Money.of(1050, 'USD') is
   * $10.50. Passing 10.5 here is the defect this throws on.
   */
  static of(minor: number, currency: string): Money {
    if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
      throw new MoneyPrecisionError(minor)
    }
    // Throws UnknownCurrencyError for a code that is neither enabled nor ISO.
    const definition = getCurrency(currency)
    return new Money(minor, definition.code)
  }

  static zero(currency: string): Money {
    return Money.of(0, currency)
  }

  static fromJSON(value: MoneyJSON): Money {
    return Money.of(value.amountMinor, value.currency)
  }

  /**
   * Parse a major-unit decimal string ("10.50") into minor units exactly.
   * Provided for reading configuration and manifest values; it is deliberately
   * not an overload of `of`, so that a call site reading minor units and a call
   * site reading a decimal string are never confused for one another.
   */
  static fromDecimal(
    decimal: string,
    currency: string,
    rounding: RoundingMode = DEFAULT_ROUNDING,
  ): Money {
    const scale = minorUnitScale(currency)
    const rational = rationalFromString(decimal)
    const minor = divRound(rational.n * scale, rational.d, rounding)
    return Money.of(toSafeNumber(minor), currency)
  }

  static isMoney(value: unknown): value is Money {
    return value instanceof Money
  }

  add(other: Money): Money {
    this.assertSameCurrency(other)
    return Money.of(toSafeNumber(this.big + other.big), this.currency)
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    return Money.of(toSafeNumber(this.big - other.big), this.currency)
  }

  /**
   * Multiply by a scalar. Exact: the factor becomes a rational before it is
   * applied, and the single division back to minor units uses `rounding`.
   */
  multiply(factor: Factor, rounding: RoundingMode = DEFAULT_ROUNDING): Money {
    const r = toRational(factor)
    return Money.of(toSafeNumber(divRound(this.big * r.n, r.d, rounding)), this.currency)
  }

  /** Divide by a scalar, with the same exactness guarantee as `multiply`. */
  divide(divisor: Factor, rounding: RoundingMode = DEFAULT_ROUNDING): Money {
    const r = toRational(divisor)
    return Money.of(toSafeNumber(divRound(this.big * r.d, r.n, rounding)), this.currency)
  }

  negate(): Money {
    return Money.of(-this.amountMinor, this.currency)
  }

  abs(): Money {
    return this.amountMinor < 0 ? this.negate() : this
  }

  /** -1, 0, or 1. Throws on a cross-currency comparison. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other)
    if (this.amountMinor < other.amountMinor) return -1
    if (this.amountMinor > other.amountMinor) return 1
    return 0
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0
  }

  isZero(): boolean {
    return this.amountMinor === 0
  }

  isPositive(): boolean {
    return this.amountMinor > 0
  }

  isNegative(): boolean {
    return this.amountMinor < 0
  }

  /**
   * The exact major-unit decimal representation, computed with integer
   * arithmetic. This is the float-free string used for serialisation, document
   * rendering, and anything that must be byte-stable.
   */
  toDecimalString(): string {
    const { minorUnits } = getCurrency(this.currency)
    const negative = this.amountMinor < 0
    const digits = Math.abs(this.amountMinor).toString().padStart(minorUnits + 1, '0')
    const cut = digits.length - minorUnits
    const whole = digits.slice(0, cut)
    const fraction = digits.slice(cut)
    const body = minorUnits === 0 ? whole : `${whole}.${fraction}`
    return negative ? `-${body}` : body
  }

  /**
   * Locale-aware presentation. Display only — never parse the result back, and
   * never persist it; persist `toJSON()` or `toDecimalString()`.
   */
  format(options: MoneyFormatOptions = {}): string {
    const { minorUnits, code } = getCurrency(this.currency)
    const display = options.display ?? 'symbol'
    // Presentation boundary: Intl takes a number. A safe-integer minor amount
    // divided by its scale round-trips exactly at this fixed fraction digit
    // count, and no computed value ever comes back out of here.
    const major = this.amountMinor / Number(minorUnitScale(code))
    const formatter = new Intl.NumberFormat(options.locale, {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
      ...(display === 'symbol' ? { style: 'currency' as const, currency: code } : {}),
    })
    const text = formatter.format(major)
    return display === 'code' ? `${code} ${text}` : text
  }

  toJSON(): MoneyJSON {
    return { amountMinor: this.amountMinor, currency: this.currency }
  }

  toString(): string {
    return `${this.currency} ${this.toDecimalString()}`
  }

  /** Internal: the amount as a bigint, for exact intermediate arithmetic. */
  private get big(): bigint {
    return BigInt(this.amountMinor)
  }

  private assertSameCurrency(other: Money): void {
    if (!Money.isMoney(other)) {
      throw new CurrencyMismatchError(this.currency, String(other))
    }
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency)
    }
  }
}

/** Sum a list of Money values. Throws on a mixed-currency list. */
export function sum(amounts: readonly Money[], currency?: string): Money {
  const first = amounts[0]
  if (first === undefined) {
    if (currency === undefined) {
      throw new CurrencyMismatchError('<empty>', '<unknown>')
    }
    return Money.zero(currency)
  }
  return amounts.reduce((total, next) => total.add(next), Money.zero(currency ?? first.currency))
}

export function toRational(factor: Factor): Rational {
  return typeof factor === 'string' ? rationalFromString(factor) : rationalFromNumber(factor)
}

export function toSafeNumber(value: bigint): number {
  const asNumber = Number(value)
  if (!Number.isSafeInteger(asNumber)) throw new MoneyPrecisionError(value.toString())
  return asNumber
}
