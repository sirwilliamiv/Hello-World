/** Errors pay.card raises. All of them are safe to surface to a caller: none
 * carries a secret, a provider credential, or card data. */

export class ChargeRejectedError extends Error {
  override readonly name = 'ChargeRejectedError'
  constructor(
    readonly reason: string,
    readonly declineCode: string | null = null,
  ) {
    super(`charge rejected by the beforeCharge slot: ${reason}`)
  }
}

export class ChargeFailedError extends Error {
  override readonly name = 'ChargeFailedError'
  constructor(
    readonly reason: string,
    readonly declineCode: string | null = null,
    readonly chargeId: string | null = null,
  ) {
    super(`charge failed: ${reason}`)
  }
}

export class CurrencyNotAllowedError extends Error {
  override readonly name = 'CurrencyNotAllowedError'
  constructor(currency: string, allowed: readonly string[]) {
    super(`currency ${currency} is not in the configured allowed_currencies [${allowed.join(', ')}]`)
  }
}

export class RefundError extends Error {
  override readonly name = 'RefundError'
}

export class UnknownChargeError extends Error {
  override readonly name = 'UnknownChargeError'
  constructor(id: string) {
    super(`no charge ${id}`)
  }
}
