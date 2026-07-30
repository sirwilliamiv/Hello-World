/**
 * Property 1: card data never touches our database.
 *
 * The primary defence is structural — the migration has no column able to hold a
 * PAN, and every value we persist is an opaque provider reference. This module is
 * the second line: a runtime assertion on the write path, so that a future change
 * which *does* introduce such a field fails a test rather than a PCI audit.
 */

export class CardDataLeakError extends Error {
  override readonly name = 'CardDataLeakError'
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

/** Field names that must never appear on a record bound for one of our tables. */
const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  /(^|_)pan(_|$)/i,
  /card_?number/i,
  /account_?number/i,
  /(^|_)cvc(_|$)/i,
  /(^|_)cvv(_|$)/i,
  /security_?code/i,
  /(^|_)track[12]?(_|$)/i,
  /magstripe/i,
  /full_?number/i,
]

/** Field names that legitimately hold digits and must not be Luhn-screened. */
const DIGIT_SAFE_FIELDS: ReadonlySet<string> = new Set([
  'last4',
  'expMonth',
  'expYear',
  'amountMinor',
  'createdAt',
])

export function isForbiddenFieldName(field: string): boolean {
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(field))
}

/**
 * A 13–19 digit string that passes the Luhn check is, for our purposes, a card
 * number. Rejecting on Luhn rather than on length alone keeps opaque provider
 * references (which are alphanumeric and prefixed) from tripping the guard.
 */
export function looksLikePan(value: string): boolean {
  const digits = value.replace(/[ -]/g, '')
  if (!/^[0-9]{13,19}$/.test(digits)) return false
  return luhnValid(digits)
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const char = digits[i]
    if (char === undefined) return false
    let digit = char.charCodeAt(0) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Called on every record before it is written to an owned table. Throws rather
 * than sanitising: silently dropping a PAN would hide the bug that produced it.
 */
export function assertNoCardData(record: Readonly<Record<string, unknown>>, table: string): void {
  for (const [field, value] of Object.entries(record)) {
    if (isForbiddenFieldName(field)) {
      throw new CardDataLeakError(
        field,
        `refusing to write '${field}' to ${table}: pay.card stores provider references only`,
      )
    }
    if (DIGIT_SAFE_FIELDS.has(field)) continue
    if (typeof value === 'string' && looksLikePan(value)) {
      throw new CardDataLeakError(
        field,
        `refusing to write ${table}.${field}: the value looks like a card number`,
      )
    }
    if (value !== null && typeof value === 'object') {
      assertNoCardData(value as Record<string, unknown>, `${table}.${field}`)
    }
  }
}

/** `last4` is display-only and must be exactly four digits, or absent. */
export function assertDisplayLast4(last4: string | null): void {
  if (last4 === null) return
  if (!/^[0-9]{4}$/.test(last4)) {
    throw new CardDataLeakError(
      'last4',
      `last4 must be exactly four digits (got ${last4.length} characters)`,
    )
  }
}
