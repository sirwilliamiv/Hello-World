/**
 * Error capture.
 *
 * Spec: `captureError(err: unknown, context?: Record<string, unknown>): void`.
 *
 * Capture is always local (a structured log record at level `error`) and
 * optionally forwarded to an external reporter. The reporter is optional in the
 * spec's `external` block, so a product with no ERROR_TRACKING_DSN loses
 * aggregation, never the log line.
 */

import { logger } from './logger.js'
import { increment } from './metrics.js'
import { redact, redactFields } from './redact.js'
import { currentTraceContext } from './trace-context.js'

export interface CapturedError {
  readonly error: unknown
  readonly context: Record<string, unknown>
  readonly traceId?: string
  readonly spanId?: string
  readonly capturedAt: string
}

export type ErrorReporter = (captured: CapturedError) => void | Promise<void>

const reporters: ErrorReporter[] = []

/**
 * Register an external error sink. The payload handed to a reporter is already
 * redacted, so a third-party SDK cannot be the thing that leaks a credential.
 */
export function registerErrorReporter(reporter: ErrorReporter): () => void {
  reporters.push(reporter)
  return () => {
    const index = reporters.indexOf(reporter)
    if (index >= 0) reporters.splice(index, 1)
  }
}

export function resetErrorReporters(): void {
  reporters.length = 0
}

function fingerprint(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : Object.prototype.toString.call(err)
}

/** Capture an exception with optional structured context. */
export function captureError(
  err: unknown,
  context?: Readonly<Record<string, unknown>>,
): void {
  const safeContext = redactFields(context)
  const safeError = redact(err)
  const trace = currentTraceContext()

  logger.error(fingerprint(err), { ...safeContext, error: safeError })
  increment('forge_errors_total', { kind: err instanceof Error ? err.name : 'unknown' })

  const captured: CapturedError = {
    error: safeError,
    context: safeContext,
    ...(trace === undefined ? {} : { traceId: trace.traceId, spanId: trace.spanId }),
    capturedAt: new Date().toISOString(),
  }

  for (const reporter of reporters) {
    try {
      const result = reporter(captured)
      if (result instanceof Promise) {
        // A reporter must never take the process down or block the request.
        result.catch((reporterError: unknown) => {
          logger.warn('error reporter failed', { error: redact(reporterError) })
        })
      }
    } catch (reporterError) {
      logger.warn('error reporter failed', { error: redact(reporterError) })
    }
  }
}

/**
 * Wrap a handler so any throw is captured and rethrown. Used by the generated
 * route wiring; also useful directly inside a capability.
 */
export function withErrorCapture<A extends readonly unknown[], R>(
  fn: (...args: A) => Promise<R> | R,
  context?: Readonly<Record<string, unknown>>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      captureError(err, context)
      throw err
    }
  }
}
