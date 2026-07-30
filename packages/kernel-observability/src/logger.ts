/**
 * Structured logging.
 *
 * Spec (kernel.observability, exposes.logger):
 *   logger.info|warn|error(msg: string, fields?: Record<string, unknown>): void
 *   "Structured only. Values bound to a declared secret name are redacted by
 *    type before emission, never by pattern matching on key names."
 *
 * Redaction happens in `emit`, before the record reaches any sink, so a custom
 * sink cannot opt out of it.
 */

import { redactFields } from './redact.js'
import { currentTraceContext } from './trace-context.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  /** ISO-8601, UTC. */
  readonly time: string
  readonly fields: Record<string, unknown>
  readonly product?: string
  readonly environment?: string
  readonly traceId?: string
  readonly spanId?: string
}

export type LogSink = (record: LogRecord) => void

export interface LoggerOptions {
  readonly level?: LogLevel
  readonly sink?: LogSink
  readonly bindings?: Readonly<Record<string, unknown>>
  readonly product?: string
  readonly environment?: string
  /** Injectable for tests; defaults to `Date`. */
  readonly now?: () => Date
}

/** The default sink: one JSON object per line, errors on stderr. */
export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record)
  if (record.level === 'error' || record.level === 'warn') {
    process.stderr.write(`${line}\n`)
  } else {
    process.stdout.write(`${line}\n`)
  }
}

export class Logger {
  #level: LogLevel
  #sink: LogSink
  #bindings: Record<string, unknown>
  #product: string | undefined
  #environment: string | undefined
  #now: () => Date

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info'
    this.#sink = options.sink ?? consoleSink
    this.#bindings = redactFields(options.bindings)
    this.#product = options.product
    this.#environment = options.environment
    this.#now = options.now ?? (() => new Date())
  }

  get level(): LogLevel {
    return this.#level
  }

  setLevel(level: LogLevel): void {
    this.#level = level
  }

  /** Replace the destination. Redaction is applied before this is called. */
  setSink(sink: LogSink): void {
    this.#sink = sink
  }

  /** Set the product/environment stamped on every record. */
  configure(options: {
    product?: string
    environment?: string
    level?: LogLevel
    sink?: LogSink
  }): void {
    if (options.product !== undefined) this.#product = options.product
    if (options.environment !== undefined) this.#environment = options.environment
    if (options.level !== undefined) this.#level = options.level
    if (options.sink !== undefined) this.#sink = options.sink
  }

  /** A logger carrying additional fields on every record. */
  child(bindings: Readonly<Record<string, unknown>>): Logger {
    const options: LoggerOptions = {
      level: this.#level,
      sink: this.#sink,
      bindings: { ...this.#bindings, ...redactFields(bindings) },
      now: this.#now,
    }
    const child = new Logger(
      this.#product === undefined
        ? this.#environment === undefined
          ? options
          : { ...options, environment: this.#environment }
        : this.#environment === undefined
          ? { ...options, product: this.#product }
          : { ...options, product: this.#product, environment: this.#environment },
    )
    return child
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.#level]
  }

  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('debug', msg, fields)
  }

  info(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('info', msg, fields)
  }

  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('warn', msg, fields)
  }

  error(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('error', msg, fields)
  }

  emit(
    level: LogLevel,
    msg: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.isLevelEnabled(level)) return

    // The single redaction point. Everything below this line is already safe.
    const safeFields = { ...this.#bindings, ...redactFields(fields) }
    const trace = currentTraceContext()

    const record: LogRecord = {
      level,
      msg,
      time: this.#now().toISOString(),
      fields: safeFields,
      ...(this.#product === undefined ? {} : { product: this.#product }),
      ...(this.#environment === undefined ? {} : { environment: this.#environment }),
      ...(trace === undefined
        ? {}
        : { traceId: trace.traceId, spanId: trace.spanId }),
    }

    this.#sink(record)
  }
}

/**
 * The process-wide logger. `initObservability` configures it; capabilities
 * import it directly.
 */
export const logger: Logger = new Logger()
