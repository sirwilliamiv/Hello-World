/**
 * A five-field cron parser, small on purpose.
 *
 * `schedule(cron, job)` is part of `kernel.work`'s exposed interface, so the
 * expression grammar has to be identical in `kernel.work` and in `ops.queue` —
 * otherwise an upgrade would silently reinterpret a client's schedules. It
 * lives here, in the upgraded capability, and `ops.queue` imports it rather
 * than re-implementing it.
 *
 * Supported: `*`, `n`, `a-b`, `* / n`, `a-b/n`, comma lists, and the
 * `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly` aliases. Deliberately not
 * supported: seconds, `L`, `W`, `#`, and named months/days.
 */

export interface CronFields {
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  readonly daysOfWeek: readonly number[]
  /** True when the field was `*`; cron's day-of-month/day-of-week OR rule needs it. */
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

export class CronParseError extends Error {
  constructor(expression: string, detail: string) {
    super(`invalid cron expression ${JSON.stringify(expression)}: ${detail}`)
    this.name = 'CronParseError'
  }
}

function parseField(raw: string, min: number, max: number, expression: string): number[] {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/', 2)
    if (range === undefined || range === '') {
      throw new CronParseError(expression, `empty field element ${JSON.stringify(part)}`)
    }
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10)
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(expression, `bad step ${JSON.stringify(stepRaw ?? '')}`)
    }

    let from: number
    let to: number
    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-', 2)
      from = Number.parseInt(a ?? '', 10)
      to = Number.parseInt(b ?? '', 10)
    } else {
      from = Number.parseInt(range, 10)
      to = stepRaw === undefined ? from : max
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new CronParseError(expression, `value ${JSON.stringify(part)} outside ${min}-${max}`)
    }
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expression: string): CronFields {
  const normalised = (ALIASES[expression.trim()] ?? expression).trim().replace(/\s+/g, ' ')
  const fields = normalised.split(' ')
  if (fields.length !== 5) {
    throw new CronParseError(expression, `expected 5 fields, got ${fields.length}`)
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  return {
    minutes: parseField(minute, 0, 59, expression),
    hours: parseField(hour, 0, 23, expression),
    daysOfMonth: parseField(dom, 1, 31, expression),
    months: parseField(month, 1, 12, expression),
    // 7 is Sunday in most crontabs; fold it onto 0.
    daysOfWeek: parseField(dow, 0, 7, expression).map((d) => d % 7),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.daysOfMonth.includes(date.getUTCDate())
  const dow = fields.daysOfWeek.includes(date.getUTCDay())
  if (fields.domRestricted && fields.dowRestricted) return dom || dow
  if (fields.domRestricted) return dom
  if (fields.dowRestricted) return dow
  return true
}

/** Days scanned before giving up. Four years covers every leap-year schedule. */
const MAX_DAYS = 366 * 4

/**
 * The first occurrence strictly after `from`, in UTC.
 *
 * UTC rather than local time is deliberate: a schedule that shifts twice a year
 * with the operator's timezone is a support ticket nobody can reproduce.
 */
export function nextCronOccurrence(expression: string, from: Date = new Date()): Date {
  const fields = parseCron(expression)
  const start = new Date(from.getTime())
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  const cursor = new Date(start.getTime())
  for (let day = 0; day < MAX_DAYS; day += 1) {
    if (fields.months.includes(cursor.getUTCMonth() + 1) && dayMatches(fields, cursor)) {
      const sameDay = day === 0
      for (const hour of fields.hours) {
        if (sameDay && hour < start.getUTCHours()) continue
        for (const minute of fields.minutes) {
          if (sameDay && hour === start.getUTCHours() && minute < start.getUTCMinutes()) continue
          return new Date(
            Date.UTC(
              cursor.getUTCFullYear(),
              cursor.getUTCMonth(),
              cursor.getUTCDate(),
              hour,
              minute,
              0,
              0,
            ),
          )
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    cursor.setUTCHours(0, 0, 0, 0)
  }
  throw new CronParseError(expression, 'no occurrence within four years')
}
