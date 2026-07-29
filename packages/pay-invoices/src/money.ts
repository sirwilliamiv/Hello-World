import { Money } from '@forge/kernel-money'

/**
 * Every read of a `Money` value goes through this module.
 *
 * kernel.money owns the primitive; pay.invoices only ever needs "give me the integer
 * minor units" and "give me the currency code". Funnelling both through two
 * functions means that if kernel.money's accessor names differ from the ones
 * assumed here, the fix is two lines in one file rather than a sweep of the
 * package.
 */

export function minorOf(amount: Money): number {
  const minor = (amount as unknown as { minor: number }).minor
  assertIntegerMinor(minor, 'Money.minor')
  return minor
}

export function currencyOf(amount: Money): string {
  return (amount as unknown as { currency: string }).currency
}

export function money(minor: number, currency: string): Money {
  assertIntegerMinor(minor, 'amount')
  return Money.of(minor, currency)
}

/**
 * Money is integer minor units. A float anywhere in a money path is a defect, so
 * we fail loudly at the boundary rather than persisting 1999.9999999999998.
 */
export function assertIntegerMinor(value: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${label} must be an integer number of minor units (got ${String(value)}). ` +
        'Money is never a float.',
    )
  }
}

export function assertCurrencyCode(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError(`currency must be a three-letter ISO 4217 code (got ${currency})`)
  }
}
