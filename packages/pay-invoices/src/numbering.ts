/**
 * Invoice number formatting and the derivation of the sequence's reset period.
 *
 * This module is pure. It decides what a number LOOKS like; it never decides what
 * the next number IS — that is `allocateInvoiceNumber` inside the insert
 * transaction (`db/port.ts`), and keeping the two apart is what makes the
 * gaplessness guarantee independent of anything a client configures or a slot
 * returns.
 */

export class InvalidNumberingSchemeError extends Error {
  override readonly name = 'InvalidNumberingSchemeError'
}

const TOKEN_RE = /\{(YYYY|YY|MM|SEQ:(\d+))\}/g
const SEQ_RE = /\{SEQ:(\d+)\}/

export interface ParsedScheme {
  readonly scheme: string
  /** Zero-padding width from `{SEQ:n}`. */
  readonly sequenceWidth: number
  /** How often the counter restarts, derived from the date tokens present. */
  readonly resetPeriod: 'month' | 'year' | 'never'
}

/**
 * Validates a numbering scheme.
 *
 * A scheme without `{SEQ:n}` cannot be gapless — there is nothing in it that
 * counts — so it is rejected rather than accepted and quietly made non-compliant.
 */
export function parseNumberingScheme(scheme: string): ParsedScheme {
  if (scheme.trim().length === 0) {
    throw new InvalidNumberingSchemeError('numbering_scheme must not be empty')
  }

  const unknown = scheme.replace(TOKEN_RE, '').match(/\{[^}]*\}/)
  if (unknown !== null) {
    throw new InvalidNumberingSchemeError(
      `numbering_scheme contains an unknown token ${unknown[0]}. ` +
        'Supported tokens are {YYYY}, {YY}, {MM}, and {SEQ:n}.',
    )
  }

  const seq = SEQ_RE.exec(scheme)
  if (seq === null) {
    throw new InvalidNumberingSchemeError(
      `numbering_scheme '${scheme}' has no {SEQ:n} token. A scheme without a sequence ` +
        'cannot be gapless, so it is rejected rather than silently accepted.',
    )
  }
  if ((scheme.match(/\{SEQ:\d+\}/g) ?? []).length > 1) {
    throw new InvalidNumberingSchemeError(
      `numbering_scheme '${scheme}' has more than one {SEQ:n} token`,
    )
  }

  const width = Number(seq[1])
  if (!Number.isInteger(width) || width < 1 || width > 12) {
    throw new InvalidNumberingSchemeError(
      `{SEQ:n} padding must be between 1 and 12 (got ${String(seq[1])})`,
    )
  }

  const resetPeriod = scheme.includes('{MM}')
    ? 'month'
    : scheme.includes('{YYYY}') || scheme.includes('{YY}')
      ? 'year'
      : 'never'

  return { scheme, sequenceWidth: width, resetPeriod }
}

/**
 * The key the counter row is held under.
 *
 * A scheme embedding the year restarts each year, so "gapless" is gapless within
 * (legal entity, period). Deriving the period from the scheme rather than
 * configuring it separately means the two cannot disagree.
 */
export function periodKey(parsed: ParsedScheme, at: Date): string {
  const year = at.getUTCFullYear()
  switch (parsed.resetPeriod) {
    case 'month':
      return `${year}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
    case 'year':
      return String(year)
    case 'never':
      return 'ALL'
  }
}

/** Substitutes the tokens. `sequence` comes from the transactional counter. */
export function formatInvoiceNumber(parsed: ParsedScheme, sequence: number, at: Date): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive integer (got ${String(sequence)})`)
  }
  const year = at.getUTCFullYear()
  return parsed.scheme
    .replace('{YYYY}', String(year))
    .replace('{YY}', String(year % 100).padStart(2, '0'))
    .replace('{MM}', String(at.getUTCMonth() + 1).padStart(2, '0'))
    .replace(SEQ_RE, String(sequence).padStart(parsed.sequenceWidth, '0'))
}
