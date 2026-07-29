/**
 * Tracing.
 *
 * Deliberately small: span creation, propagation, and a pluggable exporter.
 * A full OpenTelemetry SDK is a Phase 4 concern once there is a collector to
 * ship to; the shape here is the OTel one so that swapping the exporter is the
 * only change required.
 */

import { logger } from './logger.js'
import { observe } from './metrics.js'
import { redactFields } from './redact.js'
import {
  currentTraceContext,
  runWithTraceContext,
  type TraceContext,
} from './trace-context.js'

export type SpanStatus = 'ok' | 'error'

export interface SpanData {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly startedAt: number
  readonly durationMs: number
  readonly status: SpanStatus
  readonly attributes: Record<string, unknown>
}

export interface Span {
  readonly traceId: string
  readonly spanId: string
  setAttribute(key: string, value: unknown): void
  setAttributes(attributes: Readonly<Record<string, unknown>>): void
  recordException(error: unknown): void
  end(status?: SpanStatus): SpanData
}

export type SpanExporter = (span: SpanData) => void

const exporters: SpanExporter[] = []

export function registerSpanExporter(exporter: SpanExporter): () => void {
  exporters.push(exporter)
  return () => {
    const index = exporters.indexOf(exporter)
    if (index >= 0) exporters.splice(index, 1)
  }
}

export function resetSpanExporters(): void {
  exporters.length = 0
}

function randomHex(bytes: number): string {
  const out: string[] = []
  for (let i = 0; i < bytes; i += 1) {
    out.push(
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0'),
    )
  }
  return out.join('')
}

export function newTraceId(): string {
  return randomHex(16)
}

export function newSpanId(): string {
  return randomHex(8)
}

export interface StartSpanOptions {
  readonly attributes?: Readonly<Record<string, unknown>>
  /** Force a parent rather than inheriting the ambient context. */
  readonly parent?: TraceContext
}

/**
 * Start a span. The caller is responsible for calling `end()`; prefer
 * {@link withSpan}, which cannot leak one.
 */
export function startSpan(name: string, options: StartSpanOptions = {}): Span {
  const parent = options.parent ?? currentTraceContext()
  const traceId = parent?.traceId ?? newTraceId()
  const spanId = newSpanId()
  const startedAt = Date.now()
  const attributes: Record<string, unknown> = { ...redactFields(options.attributes) }
  let ended = false

  return {
    traceId,
    spanId,
    setAttribute(key, value) {
      const safe = redactFields({ [key]: value })
      attributes[key] = safe[key]
    },
    setAttributes(next) {
      Object.assign(attributes, redactFields(next))
    },
    recordException(error) {
      const safe = redactFields({ exception: error })
      attributes['exception'] = safe['exception']
    },
    end(status: SpanStatus = 'ok'): SpanData {
      const durationMs = Date.now() - startedAt
      const span: SpanData = {
        name,
        traceId,
        spanId,
        ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        startedAt,
        durationMs,
        status,
        attributes,
      }
      if (ended) return span
      ended = true
      observe('forge_span_duration_ms', durationMs, { span: name, status })
      for (const exporter of exporters) {
        try {
          exporter(span)
        } catch (err) {
          logger.warn('span exporter failed', { span: name, error: err })
        }
      }
      return span
    },
  }
}

/**
 * Run `fn` inside a span. The span is ended exactly once, with status `error`
 * and the exception recorded if `fn` throws, and the exception is rethrown.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options: StartSpanOptions = {},
): Promise<T> {
  const span = startSpan(name, options)
  const context: TraceContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(options.parent === undefined
      ? currentTraceContext() === undefined
        ? {}
        : { parentSpanId: currentTraceContext()?.spanId ?? '' }
      : { parentSpanId: options.parent.spanId }),
  }

  return runWithTraceContext(context, async () => {
    try {
      const result = await fn(span)
      span.end('ok')
      return result
    } catch (err) {
      span.recordException(err)
      span.end('error')
      throw err
    }
  })
}

export { currentTraceContext, runWithTraceContext }
export type { TraceContext }

/** W3C `traceparent` for outbound calls. Version 00, sampled. */
export function traceparent(context = currentTraceContext()): string | undefined {
  if (context === undefined) return undefined
  return `00-${context.traceId}-${context.spanId}-01`
}

/** Parse an inbound W3C `traceparent`. Returns undefined when malformed. */
export function parseTraceparent(header: string | null): TraceContext | undefined {
  if (header === null) return undefined
  const parts = header.split('-')
  if (parts.length !== 4) return undefined
  const [, traceId, spanId] = parts
  if (traceId === undefined || spanId === undefined) return undefined
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return undefined
  }
  return { traceId, spanId }
}
