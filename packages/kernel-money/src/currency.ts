/**
 * The currency registry.
 *
 * `registerCurrency` is called from the generated file
 * `src/generated/kernel.money/currencies.ts`, which renders the currency set the
 * manifest enabled for this product. Anything registered there is "enabled";
 * `listCurrencies()` returns exactly that set, so a UI currency picker is driven
 * by the manifest rather than by a hardcoded list.
 *
 * A small ISO 4217 table is built in as a *fallback for lookup only*. It means
 * Money.of(1000, 'JPY') knows JPY has no minor unit even before the product
 * enables JPY, while a typo such as 'USDD' still fails loudly.
 */

import { UnknownCurrencyError } from './errors.js'

export interface CurrencyDefinition {
  /** ISO 4217 alphabetic code, uppercase. */
  readonly code: string
  /**
   * The ISO 4217 minor-unit exponent: 2 for USD (cents), 0 for JPY, 3 for KWD.
   * This is a display and conversion concern only — Money always stores whole
   * minor units.
   */
  readonly minorUnits: number
  /** Optional human label for admin surfaces. */
  readonly name?: string
  /** Optional symbol; formatting falls back to Intl when absent. */
  readonly symbol?: string
}

const CODE = /^[A-Z]{3}$/

/** ISO 4217 minor-unit exponents for the codes a product is likely to meet. */
const ISO_MINOR_UNITS: Readonly<Record<string, number>> = {
  AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CZK: 2,
  DKK: 2, EUR: 2, GBP: 2, HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0,
  JOD: 3, JPY: 0, KRW: 0, KWD: 3, MXN: 2, MYR: 2, NOK: 2, NZD: 2, OMR: 3,
  PHP: 2, PLN: 2, RON: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2, TWD: 2,
  USD: 2, VND: 0, ZAR: 2,
}

const enabled = new Map<string, CurrencyDefinition>()

/**
 * Enable a currency for this product. Called by generated code; calling it twice
 * with the same code replaces the definition, which keeps re-execution of the
 * generated module idempotent.
 */
export function registerCurrency(definition: CurrencyDefinition): CurrencyDefinition {
  const code = definition.code.toUpperCase()
  if (!CODE.test(code)) {
    throw new UnknownCurrencyError(definition.code)
  }
  if (!Number.isInteger(definition.minorUnits) || definition.minorUnits < 0 || definition.minorUnits > 4) {
    throw new RangeError(
      `currency ${code}: minorUnits must be an integer between 0 and 4, got ${String(definition.minorUnits)}`,
    )
  }
  const normalized: CurrencyDefinition = { ...definition, code }
  enabled.set(code, normalized)
  return normalized
}

/** Resolve a currency: the product's enabled set first, then the ISO table. */
export function getCurrency(code: string): CurrencyDefinition {
  const upper = code.toUpperCase()
  const registered = enabled.get(upper)
  if (registered !== undefined) return registered

  const isoMinorUnits = CODE.test(upper) ? ISO_MINOR_UNITS[upper] : undefined
  if (isoMinorUnits === undefined) throw new UnknownCurrencyError(code)
  return { code: upper, minorUnits: isoMinorUnits }
}

/** True when the code resolves at all — enabled or known ISO. */
export function isKnownCurrency(code: string): boolean {
  try {
    getCurrency(code)
    return true
  } catch {
    return false
  }
}

/** The currencies this product enabled, in registration order. */
export function listCurrencies(): CurrencyDefinition[] {
  return [...enabled.values()]
}

/** The minor-unit exponent for a currency. `minorUnitScale('USD') === 100n`. */
export function minorUnitScale(code: string): bigint {
  return 10n ** BigInt(getCurrency(code).minorUnits)
}

/** Test helper. Not used by generated code. */
export function clearCurrencies(): void {
  enabled.clear()
}
