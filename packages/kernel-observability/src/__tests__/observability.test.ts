/**
 * Metrics, tracing, event sampling, and the `initObservability` call site the
 * generated `src/instrumentation.ts` uses.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resetHealthChecks, registerHealthCheck } from '../health.js'
import { initObservability, resetObservability } from '../init.js'
import { Logger, type LogRecord } from '../logger.js'
import {
  increment,
  metricsHandler,
  observe,
  renderMetrics,
  resetMetrics,
  setGauge,
  timed,
} from '../metrics.js'
import { configureSampling, sampleEvent } from '../sample-event.js'
import { isSecret } from '../secret.js'
import { resetTraceContext } from '../trace-context.js'
import {
  parseTraceparent,
  registerSpanExporter,
  resetSpanExporters,
  traceparent,
  withSpan,
  type SpanData,
} from '../tracing.js'

describe('metrics', () => {
  beforeEach(() => {
    resetMetrics()
  })

  it('renders counters, gauges and histograms in Prometheus text format', () => {
    increment('http_requests_total', { route: '/admin', status: 200 })
    increment('http_requests_total', { route: '/admin', status: 200 })
    setGauge('queue_depth', 7)
    observe('handler_duration_ms', 3)

    const text = renderMetrics()
    expect(text).toContain('# TYPE http_requests_total counter')
    expect(text).toContain('http_requests_total{route="/admin",status="200"} 2')
    expect(text).toContain('queue_depth 7')
    expect(text).toContain('handler_duration_ms_count 1')
    expect(text).toContain('handler_duration_ms_bucket{le="5"} 1')
    expect(text).toContain('handler_duration_ms_bucket{le="+Inf"} 1')
  })

  it('sorts output so a scrape diff is reviewable', () => {
    increment('z_total')
    increment('a_total')
    const names = renderMetrics()
      .split('\n')
      .filter((l) => l.startsWith('# HELP'))
    expect(names[0]).toContain('a_total')
    expect(names[1]).toContain('z_total')
  })

  it('serves /metrics with the Prometheus content type', async () => {
    increment('a_total')
    const response = metricsHandler()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toContain('a_total 1')
  })

  it('records an outcome label from timed()', async () => {
    await timed('op_ms', () => 'fine')
    await expect(
      timed('op_ms', () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')

    const text = renderMetrics()
    expect(text).toContain('outcome="ok"')
    expect(text).toContain('outcome="error"')
  })
})

describe('tracing', () => {
  beforeEach(() => {
    resetSpanExporters()
    resetTraceContext()
    resetMetrics()
  })

  it('exports a span with a duration and a status', async () => {
    const spans: SpanData[] = []
    registerSpanExporter((s) => spans.push(s))

    await withSpan('charge', async (span) => {
      span.setAttribute('amount', 1250)
      return 'ok'
    })

    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('charge')
    expect(spans[0]?.status).toBe('ok')
    expect(spans[0]?.attributes['amount']).toBe(1250)
    expect(spans[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('marks a span errored and rethrows', async () => {
    const spans: SpanData[] = []
    registerSpanExporter((s) => spans.push(s))

    await expect(
      withSpan('charge', () => {
        throw new Error('declined')
      }),
    ).rejects.toThrow('declined')

    expect(spans[0]?.status).toBe('error')
  })

  it('nests child spans under the same trace id', async () => {
    const spans: SpanData[] = []
    registerSpanExporter((s) => spans.push(s))

    await withSpan('outer', async () => {
      await withSpan('inner', () => undefined)
    })

    const outer = spans.find((s) => s.name === 'outer')
    const inner = spans.find((s) => s.name === 'inner')
    expect(inner?.traceId).toBe(outer?.traceId)
    expect(inner?.parentSpanId).toBe(outer?.spanId)
  })

  it('stamps the trace id onto log records emitted inside the span', async () => {
    const records: LogRecord[] = []
    const logger = new Logger({ level: 'debug', sink: (r) => records.push(r) })

    await withSpan('outer', () => {
      logger.info('inside')
    })

    expect(records[0]?.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('round-trips a W3C traceparent header', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    const parsed = parseTraceparent(header)
    expect(parsed?.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(traceparent(parsed)).toBe(header)
    expect(parseTraceparent('garbage')).toBeUndefined()
    expect(parseTraceparent(null)).toBeUndefined()
  })
})

describe('sampleEvent', () => {
  beforeEach(() => {
    resetMetrics()
    configureSampling({ payloadSampleRate: 0 })
  })

  it('counts every event without logging payloads by default', async () => {
    await sampleEvent({ name: 'payment.succeeded', contractVersion: 2 })
    await sampleEvent({ name: 'payment.succeeded', contractVersion: 2 })

    expect(renderMetrics()).toContain(
      'forge_events_total{event="payment.succeeded",version="2"} 2',
    )
  })
})

describe('initObservability', () => {
  beforeEach(() => {
    resetObservability()
    resetHealthChecks()
    resetMetrics()
  })

  it('accepts exactly the fields the generated instrumentation.ts passes', async () => {
    const result = await initObservability({
      product: 'acme',
      environment: 'production',
      installProcessHandlers: false,
      env: {},
    })

    expect(result.product).toBe('acme')
    expect(result.environment).toBe('production')
    expect(result.errorTrackingDsn).toBeUndefined()
    expect(renderMetrics()).toContain(
      'forge_build_info{environment="production",product="acme"} 1',
    )
  })

  it('binds optional credentials as Secrets, never as strings', async () => {
    const result = await initObservability({
      product: 'acme',
      environment: 'production',
      installProcessHandlers: false,
      env: { ERROR_TRACKING_DSN: 'https://key@errors.example/1' },
    })

    expect(isSecret(result.errorTrackingDsn)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('errors.example')
  })

  it('logs configuration presence, never configuration values', async () => {
    const records: LogRecord[] = []
    await initObservability({
      product: 'acme',
      environment: 'production',
      installProcessHandlers: false,
      sink: (r) => records.push(r),
      env: { ERROR_TRACKING_DSN: 'https://key@errors.example/1' },
    })

    const init = records.find((r) => r.msg === 'observability initialised')
    expect(init?.fields['errorTracking']).toBe(true)
    expect(JSON.stringify(records)).not.toContain('errors.example')
  })

  it('leaves the required health probes to the capabilities that own them', async () => {
    await initObservability({
      product: 'acme',
      environment: 'production',
      installProcessHandlers: false,
      env: {},
      requiredChecks: ['database'],
    })
    registerHealthCheck({ name: 'database', check: () => true })

    const { checkHealth } = await import('../health.js')
    expect((await checkHealth()).status).toBe('ok')
  })
})
