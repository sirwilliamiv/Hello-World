/**
 * Process-start wiring.
 *
 * Call site is generated — `templates/kernel.observability/instrumentation.ts.tmpl`:
 *
 *   export async function register() {
 *     const { initObservability } = await import('@forge/kernel-observability')
 *     await initObservability({ product: "...", environment: "..." })
 *   }
 *
 * So `initObservability({ product, environment })` must work with exactly those
 * two fields. Everything else is optional and defaulted.
 */

import { captureError, registerErrorReporter, type ErrorReporter } from './errors.js'
import { configureHealth } from './health.js'
import { logger, type LogLevel, type LogSink } from './logger.js'
import { defineMetric, setGauge } from './metrics.js'
import { configureSampling } from './sample-event.js'
import { optionalCredential, type CredentialSource, type Secret } from './secret.js'
import { installAsyncContext } from './trace-context.js'

export interface ObservabilityOptions {
  /** The product id from the manifest. */
  readonly product: string
  /** The workspace environment: `production`, `staging`, `development`. */
  readonly environment: string
  readonly level?: LogLevel
  readonly sink?: LogSink
  /**
   * Health check names that must report `ok` for readiness. Defaults to
   * `['database', 'queue']` per the spec's `/health` description.
   */
  readonly requiredChecks?: readonly string[]
  /** 0..1 fraction of events whose payloads are logged. Default 0. */
  readonly payloadSampleRate?: number
  /** Injectable for tests. Defaults to `process.env`. */
  readonly env?: CredentialSource
  /** Install `process.on('uncaughtException' | 'unhandledRejection')`. Default true. */
  readonly installProcessHandlers?: boolean
}

export interface Observability {
  readonly product: string
  readonly environment: string
  /** Whether AsyncLocalStorage-backed trace propagation is available. */
  readonly asyncContext: boolean
  /**
   * The error-tracking DSN, bound as a Secret if declared. Present so callers
   * can see *that* it is configured without being able to read it.
   */
  readonly errorTrackingDsn: Secret<string> | undefined
  readonly metricsEndpoint: Secret<string> | undefined
}

let initialised: Observability | undefined
let processHandlersInstalled = false

/**
 * Idempotent. Next.js can evaluate `instrumentation.ts` more than once (dev
 * server reloads, multiple runtimes), and duplicate process handlers would
 * report the same crash twice.
 */
export async function initObservability(
  options: ObservabilityOptions,
): Promise<Observability> {
  const { product, environment } = options
  const env = options.env ?? (process.env as CredentialSource)

  logger.configure({
    product,
    environment,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  })

  configureHealth({
    product,
    environment,
    ...(options.requiredChecks === undefined
      ? {}
      : { requiredChecks: options.requiredChecks }),
  })

  if (options.payloadSampleRate !== undefined) {
    configureSampling({ payloadSampleRate: options.payloadSampleRate })
  }

  const asyncContext = await installAsyncContext()

  defineMetric({
    name: 'forge_events_total',
    kind: 'counter',
    help: 'Events observed on the bus, by name and contract version.',
  })
  defineMetric({
    name: 'forge_errors_total',
    kind: 'counter',
    help: 'Exceptions captured, by error name.',
  })
  defineMetric({
    name: 'forge_span_duration_ms',
    kind: 'histogram',
    help: 'Span duration in milliseconds, by span name and status.',
  })
  defineMetric({
    name: 'forge_health_status',
    kind: 'gauge',
    help: '1 when the last readiness evaluation passed, 0 otherwise.',
  })
  defineMetric({
    name: 'forge_health_check_status',
    kind: 'gauge',
    help: '1 when an individual health probe passed, 0 otherwise.',
  })
  setGauge('forge_build_info', 1, { product, environment })

  // Both credentials are declared `optional: true` in the spec, so their
  // absence is a configuration choice, not an error.
  const errorTrackingDsn = optionalCredential('ERROR_TRACKING_DSN', env)
  const metricsEndpoint = optionalCredential('METRICS_ENDPOINT', env)

  if (options.installProcessHandlers !== false && !processHandlersInstalled) {
    installProcessHandlers()
    processHandlersInstalled = true
  }

  initialised = {
    product,
    environment,
    asyncContext,
    errorTrackingDsn,
    metricsEndpoint,
  }

  logger.info('observability initialised', {
    asyncContext,
    // Note what is configured, never the value. The Secret type makes the
    // alternative impossible rather than merely discouraged.
    errorTracking: errorTrackingDsn !== undefined,
    metricsForwarding: metricsEndpoint !== undefined,
  })

  return initialised
}

export function observability(): Observability | undefined {
  return initialised
}

/** Test seam. */
export function resetObservability(): void {
  initialised = undefined
}

function installProcessHandlers(): void {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return
  process.on('uncaughtException', (err: unknown) => {
    captureError(err, { source: 'uncaughtException' })
  })
  process.on('unhandledRejection', (reason: unknown) => {
    captureError(reason, { source: 'unhandledRejection' })
  })
}

export type { ErrorReporter }
export { registerErrorReporter }
