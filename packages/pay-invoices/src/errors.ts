export class InvoiceNotFoundError extends Error {
  override readonly name = 'InvoiceNotFoundError'
  constructor(id: string) {
    super(`no invoice ${id}`)
  }
}

export class InvoiceAlreadyVoidError extends Error {
  override readonly name = 'InvoiceAlreadyVoidError'
  constructor(id: string) {
    super(`invoice ${id} is already void`)
  }
}

export class InvoiceNotEmptyError extends Error {
  override readonly name = 'InvoiceNotEmptyError'
  constructor() {
    super('an invoice must have at least one line')
  }
}

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError'
  constructor(expected: string, got: string) {
    super(`every line on an invoice must share a currency: expected ${expected}, got ${got}`)
  }
}

export class DocumentRenderError extends Error {
  override readonly name = 'DocumentRenderError'
}
