/**
 * Test double for @forge/kernel-money.
 *
 * kernel.money is owned by another capability and is not implemented yet. This
 * double implements only the contract this package uses — `Money.of`, the minor
 * and currency accessors, arithmetic, and `allocate` — in integer minor units, so
 * a float can never sneak through a test and pass.
 *
 * vitest aliases '@forge/kernel-money' here only when the real package has no
 * source on disk; see vitest.config.ts.
 */

export class Money {
  private constructor(
    readonly minor: number,
    readonly currency: string,
  ) {
    if (!Number.isSafeInteger(minor)) {
      throw new TypeError(`Money must be integer minor units, got ${String(minor)}`)
    }
    Object.freeze(this)
  }

  static of(minor: number, currency: string): Money {
    return new Money(minor, currency)
  }

  static zero(currency: string): Money {
    return new Money(0, currency)
  }

  add(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(this.minor + other.minor, this.currency)
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(this.minor - other.minor, this.currency)
  }

  multiply(factor: number): Money {
    if (!Number.isSafeInteger(factor)) {
      throw new TypeError('Money.multiply takes an integer factor')
    }
    return new Money(this.minor * factor, this.currency)
  }

  compare(other: Money): number {
    this.assertSameCurrency(other)
    return this.minor === other.minor ? 0 : this.minor < other.minor ? -1 : 1
  }

  isZero(): boolean {
    return this.minor === 0
  }

  format(): string {
    const sign = this.minor < 0 ? '-' : ''
    const abs = Math.abs(this.minor)
    const units = Math.trunc(abs / 100)
    const cents = abs % 100
    return `${sign}${units}.${String(cents).padStart(2, '0')} ${this.currency}`
  }

  toJSON(): { minor: number; currency: string } {
    return { minor: this.minor, currency: this.currency }
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`currency mismatch: ${this.currency} vs ${other.currency}`)
    }
  }
}

/** Deterministic largest-remainder split; never loses or invents a minor unit. */
export function allocate(total: Money, ratios: readonly number[]): Money[] {
  const sum = ratios.reduce((a, b) => a + b, 0)
  if (sum <= 0) throw new RangeError('allocate requires ratios summing to more than zero')
  const shares = ratios.map((r) => Math.floor((total.minor * r) / sum))
  let remainder = total.minor - shares.reduce((a, b) => a + b, 0)
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length, remainder -= 1) {
    shares[i] = (shares[i] ?? 0) + 1
  }
  return shares.map((s) => Money.of(s, total.currency))
}

export function registerCurrency(_: { code: string; minorUnits: number }): void {
  /* no-op in the double */
}
