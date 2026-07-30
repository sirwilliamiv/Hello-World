/**
 * Errors raised by the money kernel.
 *
 * Every one of these represents a condition that must fail loudly. Money is the
 * one primitive where a silent coercion is always a defect: a rounded float, a
 * currency coerced to another currency, or an allocation that loses a minor unit
 * are all bugs that surface much later as an unreconcilable ledger.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Arithmetic was attempted between two different currencies. Never coerce. */
export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(
      `cannot combine ${left} and ${right}: cross-currency arithmetic must go through an explicit conversion with a recorded ExchangeRate`,
    )
  }
}

/** A currency code that is neither registered for this product nor a known ISO 4217 code. */
export class UnknownCurrencyError extends MoneyError {
  constructor(readonly code: string) {
    super(
      `unknown currency ${JSON.stringify(code)}: register it with registerCurrency({ code, minorUnits }) in src/generated/kernel.money/currencies.ts`,
    )
  }
}

/**
 * A non-integer, non-finite, or unsafe amount reached the money layer.
 * Money is integer minor units only; a float amount is a defect, not a rounding
 * opportunity.
 */
export class MoneyPrecisionError extends MoneyError {
  constructor(readonly value: unknown) {
    super(
      `amount ${String(value)} is not a safe integer number of minor units: Money holds integer minor units only`,
    )
  }
}

/** An allocation was requested that cannot be satisfied deterministically. */
export class AllocationError extends MoneyError {}
