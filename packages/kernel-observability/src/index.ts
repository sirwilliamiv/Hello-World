/**
 * @forge/kernel-observability
 *
 * Errors, logs, metrics, health. Present in every product because a client
 * whose application is down is the only situation in which every other
 * guarantee in this system stops mattering.
 *
 * Spec: catalog/kernel/kernel.observability.capability.json
 */

// exposes.interface: logger
export { Logger, logger, consoleSink } from './logger.js'
export type { LogLevel, LogRecord, LogSink, LoggerOptions } from './logger.js'

// exposes.interface: captureError
export {
  captureError,
  registerErrorReporter,
  resetErrorReporters,
  withErrorCapture,
} from './errors.js'
export type { CapturedError, ErrorReporter } from './errors.js'

// exposes.route: /health
export {
  REQUIRED_CHECKS,
  checkHealth,
  configureHealth,
  healthHandler,
  registerHealthCheck,
  registeredHealthChecks,
  resetHealthChecks,
  unregisterHealthCheck,
} from './health.js'
export type {
  HealthCheck,
  HealthCheckReport,
  HealthCheckResult,
  HealthReport,
  HealthStatus,
} from './health.js'

// exposes.route: /metrics
export {
  defineMetric,
  increment,
  metricsHandler,
  observe,
  renderMetrics,
  resetMetrics,
  setGauge,
  timed,
} from './metrics.js'
export type { Labels, MetricDefinition, MetricKind } from './metrics.js'

// Tracing.
export {
  currentTraceContext,
  newSpanId,
  newTraceId,
  parseTraceparent,
  registerSpanExporter,
  resetSpanExporters,
  runWithTraceContext,
  startSpan,
  traceparent,
  withSpan,
} from './tracing.js'
export type {
  Span,
  SpanData,
  SpanExporter,
  SpanStatus,
  StartSpanOptions,
  TraceContext,
} from './tracing.js'
export { installAsyncContext, resetTraceContext } from './trace-context.js'

// Secret handling — ARCHITECTURE §9.4. Redaction is by type, never by name.
export {
  MissingCredentialError,
  REDACTED,
  Secret,
  bindCredentials,
  credential,
  exposeIfSecret,
  isSecret,
  optionalCredential,
  secret,
} from './secret.js'
export type { CredentialSource } from './secret.js'
export { redact, redactFields } from './redact.js'
export type { RedactOptions, RedactedError } from './redact.js'

// consumes handler, imported by src/generated/kernel.events/subscriptions.ts.
export { configureSampling, sampleEvent } from './sample-event.js'
export type { SampledEvent, SamplingOptions } from './sample-event.js'

// Process-start wiring, imported by src/instrumentation.ts.
export { initObservability, observability, resetObservability } from './init.js'
export type { Observability, ObservabilityOptions } from './init.js'
