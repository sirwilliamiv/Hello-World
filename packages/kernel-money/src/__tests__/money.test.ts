/**
 * Smoke test: "cross-currency arithmetic is rejected", plus the integer-only
 * invariant that the whole capability rests on.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearCurrencies, getCurrency, listCurrencies, registerCurrency } from '../currency.js'
import { convert, invertRate } from '../exchange.js'
import { CurrencyMismatchError, MoneyPrecisionError, UnknownCurrencyError } from '../errors.js'
import { Money, sum } from '../money.js'

describe('Money', () => {
  beforeEach(() => {
    clearCurrencies()
  })

  it('rejects cross-currency arithmetic rather than coercing', () => {
    const usd = Money.of(1000, 'USD')
    const eur = Money.of(1000, 'EUR')

    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError)
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError)
    expect(() => usd.compare(eur)).toThrow(CurrencyMismatchError)
    expect(() => sum([usd, eur])).toThrow(CurrencyMismatchError)

    // equals is a total predicate — it answers false rather than throwing,
    // because "is this the same money" is a legitimate question across currencies.
    expect(usd.equals(eur)).toBe(false)
  })

  it('holds integer minor units only', () => {
    expect(() => Money.of(10.5, 'USD')).toThrow(MoneyPrecisionError)
    expect(() => Money.of(Number.NaN, 'USD')).toThrow(MoneyPrecisionError)
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 2, 'USD')).toThrow(MoneyPrecisionError)
    expect(Money.of(1050, 'USD').amountMinor).toBe(1050)
  })

  it('adds and subtracts exactly', () => {
    expect(Money.of(1010, 'USD').add(Money.of(2035, 'USD')).amountMinor).toBe(3045)
    expect(Money.of(1010, 'USD').subtract(Money.of(2035, 'USD')).amountMinor).toBe(-1025)
    expect(sum([Money.of(1, 'USD'), Money.of(2, 'USD'), Money.of(3, 'USD')]).amountMinor).toBe(6)
  })

  it('multiplies through exact rationals, not floats', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; the rational path is exact.
    expect(Money.of(1000, 'USD').multiply(0.1).amountMinor).toBe(100)
    expect(Money.of(2035, 'USD').multiply('0.0725').amountMinor).toBe(148) // 147.5375 -> 148
    // Banker's rounding by default: exact halves go to the even minor unit.
    expect(Money.of(5, 'USD').multiply(0.5).amountMinor).toBe(2)
    expect(Money.of(15, 'USD').multiply(0.5).amountMinor).toBe(8)
    expect(Money.of(5, 'USD').multiply(0.5, 'half_up').amountMinor).toBe(3)
    expect(Money.of(5, 'USD').multiply(0.5, 'down').amountMinor).toBe(2)
  })

  it('divides with the same exactness guarantee', () => {
    expect(Money.of(1000, 'USD').divide(3, 'down').amountMinor).toBe(333)
    expect(Money.of(1000, 'USD').divide(3, 'up').amountMinor).toBe(334)
  })

  it('round-trips through JSON without losing a unit', () => {
    const original = Money.of(-987654, 'USD')
    expect(Money.fromJSON(original.toJSON()).equals(original)).toBe(true)
  })

  it('renders an exact, float-free decimal string', () => {
    expect(Money.of(1050, 'USD').toDecimalString()).toBe('10.50')
    expect(Money.of(5, 'USD').toDecimalString()).toBe('0.05')
    expect(Money.of(-5, 'USD').toDecimalString()).toBe('-0.05')
    expect(Money.of(1050, 'JPY').toDecimalString()).toBe('1050')
    expect(Money.of(1050, 'KWD').toDecimalString()).toBe('1.050')
  })

  it('parses major-unit decimals into minor units', () => {
    expect(Money.fromDecimal('10.50', 'USD').amountMinor).toBe(1050)
    expect(Money.fromDecimal('-0.01', 'USD').amountMinor).toBe(-1)
    expect(Money.fromDecimal('1050', 'JPY').amountMinor).toBe(1050)
  })

  it('honours a currency with no minor unit', () => {
    const yen = Money.of(1000, 'JPY')
    expect(yen.add(Money.of(1, 'JPY')).amountMinor).toBe(1001)
    expect(getCurrency('JPY').minorUnits).toBe(0)
  })
})

describe('currency registry', () => {
  beforeEach(() => {
    clearCurrencies()
  })

  it('reports only the currencies the product enabled', () => {
    expect(listCurrencies()).toHaveLength(0)
    registerCurrency({ code: 'USD', minorUnits: 2 })
    registerCurrency({ code: 'usd', minorUnits: 2 }) // idempotent, normalised
    expect(listCurrencies().map((c) => c.code)).toEqual(['USD'])
  })

  it('rejects an unknown code rather than guessing a minor unit', () => {
    expect(() => Money.of(100, 'USDD')).toThrow(UnknownCurrencyError)
    expect(() => Money.of(100, 'ZZZ')).toThrow(UnknownCurrencyError)
  })
})

describe('convert', () => {
  it('requires an explicit rate and refuses a mismatched one', () => {
    const rate = { from: 'USD', to: 'EUR', rate: '0.92', asOf: new Date(0) }
    expect(convert(Money.of(1000, 'USD'), rate).amountMinor).toBe(920)
    expect(() => convert(Money.of(1000, 'EUR'), rate)).toThrow(CurrencyMismatchError)
  })

  it('crosses differing minor-unit exponents without a float', () => {
    const rate = { from: 'USD', to: 'JPY', rate: '157.25', asOf: new Date(0) }
    // $10.00 * 157.25 = ¥1572.5 -> banker's rounding to ¥1572
    expect(convert(Money.of(1000, 'USD'), rate).amountMinor).toBe(1572)
  })

  it('inverts a rate', () => {
    const inverted = invertRate({ from: 'USD', to: 'EUR', rate: '0.5', asOf: new Date(0) })
    expect(inverted.from).toBe('EUR')
    expect(inverted.to).toBe('USD')
    expect(Number(inverted.rate)).toBe(2)
  })
})
