/**
 * `exposes: { kind: "registry", name: "templateHelpers" }`.
 *
 * "Formatting helpers contributed by capabilities, so a money value renders
 * identically in an invoice, a quote, and a report."
 *
 * Two rules for anything registered here, and they are the same rule twice:
 *
 *  - **Pure.** No clock, no random source, no ambient state. A helper that reads the
 *    date makes every reissue of a historical document differ from the original.
 *  - **Locale-independent.** No `Intl`, no `toLocaleString`. Formatting must not
 *    depend on the host's ICU data or the server's environment, or the same document
 *    rendered on two machines is two different documents.
 *
 * Money is the exception that proves it: it is not formatted here at all. It is
 * handed to `kernel.money`, which owns the primitive, so an amount cannot render one
 * way in an invoice and another way in a quote.
 */
import { DocumentsError } from './errors.js'
import type { TemplateHelper } from './slots.js'
import type { MoneyLike } from './ports.js'
import { stringify } from './template-engine.js'

const registry = new Map<string, TemplateHelper>()

export interface TemplateHelperRegistry {
  register(name: string, helper: TemplateHelper): void
  registerAll(helpers: Readonly<Record<string, TemplateHelper>>): void
  get(name: string): TemplateHelper | undefined
  names(): string[]
  all(): Readonly<Record<string, TemplateHelper>>
}

export const templateHelpers: TemplateHelperRegistry = {
  register(name, helper) {
    registry.set(name, helper)
  },
  registerAll(helpers) {
    for (const [name, helper] of Object.entries(helpers)) registry.set(name, helper)
  },
  get(name) {
    return registry.get(name)
  },
  names() {
    return [...registry.keys()].sort()
  },
  all() {
    // Sorted so the "registered helpers: …" error message is stable.
    return Object.fromEntries([...registry.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  },
}

// ── money, via kernel.money and only via kernel.money ───────────────────────────

let money: MoneyLike | null = null

/** Called by the render path once the runtime is loaded. */
export function useMoney(impl: MoneyLike): void {
  money = impl
}

function moneyHelper(...args: readonly unknown[]): string {
  const [amount, currency] = args
  if (money === null) {
    throw new DocumentsError(
      'money_unavailable',
      'The money helper needs kernel.money, which has not been loaded yet.',
    )
  }
  const minor =
    typeof amount === 'object' && amount !== null && 'minor' in amount
      ? (amount as { minor: unknown }).minor
      : amount
  const code =
    typeof amount === 'object' && amount !== null && 'currency' in amount
      ? (amount as { currency: unknown }).currency
      : currency

  if (typeof minor !== 'number' || !Number.isInteger(minor)) {
    throw new DocumentsError(
      'money_not_minor_units',
      `money expects integer minor units, got ${JSON.stringify(minor)}. ` +
        'A float here is a rounding bug waiting for an audit.',
    )
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new DocumentsError('money_no_currency', 'money expects a currency code.')
  }
  return money.of(minor, code).format()
}

// ── deterministic formatting built-ins ──────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * Formats an ISO-8601 instant in **UTC**, with fixed English month names.
 * Deliberately not `Intl.DateTimeFormat`: its output depends on the ICU build.
 */
function dateHelper(...args: readonly unknown[]): string {
  const [value, format] = args
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  const pattern = typeof format === 'string' ? format : 'YYYY-MM-DD'
  const month = date.getUTCMonth()
  return pattern
    .replace(/YYYY/g, String(date.getUTCFullYear()))
    .replace(/MMMM/g, MONTHS[month] as string)
    .replace(/MMM/g, (MONTHS[month] as string).slice(0, 3))
    .replace(/MM/g, pad(month + 1, 2))
    .replace(/DD/g, pad(date.getUTCDate(), 2))
    .replace(/HH/g, pad(date.getUTCHours(), 2))
    .replace(/mm/g, pad(date.getUTCMinutes(), 2))
}

/** Fixed-decimal formatting with thousands separators, no locale involved. */
function numberHelper(...args: readonly unknown[]): string {
  const [value, decimals] = args
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  const places = typeof decimals === 'number' ? decimals : 0
  const fixed = Math.abs(n).toFixed(places)
  const [whole = '0', fraction] = fixed.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const sign = n < 0 ? '-' : ''
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`
}

templateHelpers.registerAll({
  money: moneyHelper,
  date: dateHelper,
  number: numberHelper,
  percent: (...args) => `${numberHelper(args[0], args[1] ?? 1)}%`,
  upper: (...args) => stringify(args[0]).toUpperCase(),
  lower: (...args) => stringify(args[0]).toLowerCase(),
  join: (...args) =>
    Array.isArray(args[0])
      ? args[0].map(stringify).join(typeof args[1] === 'string' ? args[1] : ', ')
      : stringify(args[0]),
  default: (...args) => {
    const value = stringify(args[0])
    return value === '' ? stringify(args[1]) : value
  },
  add: (...args) => String(Number(args[0] ?? 0) + Number(args[1] ?? 0)),
})
