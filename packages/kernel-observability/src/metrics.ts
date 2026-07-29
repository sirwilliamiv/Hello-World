/**
 * Metrics.
 *
 * An in-process registry rendered in Prometheus text exposition format at
 * `/metrics` (spec: exposes.route `metrics`). Pull-based, because a scrape
 * endpoint works identically on a laptop, in CI, and behind Cloud Run, and
 * needs no credential to be useful in development.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram'

export type Labels = Readonly<Record<string, string | number | boolean>>

export interface MetricDefinition {
  readonly name: string
  readonly kind: MetricKind
  readonly help: string
  /** Histogram upper bounds, in the metric's own unit. */
  readonly buckets?: readonly number[]
}

interface Series {
  readonly labels: Labels
  readonly labelKey: string
  value: number
  count: number
  sum: number
  bucketCounts: number[]
}

interface Metric {
  readonly definition: MetricDefinition
  readonly series: Map<string, Series>
}

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const

const metrics = new Map<string, Metric>()

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  return keys.map((k) => `${k}=${String(labels[k])}`).join(',')
}

function ensure(definition: MetricDefinition): Metric {
  const existing = metrics.get(definition.name)
  if (existing !== undefined) return existing
  const metric: Metric = { definition, series: new Map() }
  metrics.set(definition.name, metric)
  return metric
}

function series(metric: Metric, labels: Labels): Series {
  const key = labelKey(labels)
  const existing = metric.series.get(key)
  if (existing !== undefined) return existing
  const bucketCount = (metric.definition.buckets ?? DEFAULT_BUCKETS).length
  const created: Series = {
    labels,
    labelKey: key,
    value: 0,
    count: 0,
    sum: 0,
    bucketCounts: new Array<number>(bucketCount).fill(0),
  }
  metric.series.set(key, created)
  return created
}

/**
 * Declare a metric up front. Optional — the increment/observe helpers create a
 * definition lazily — but a declared `help` string is what makes a dashboard
 * readable by someone who did not write the code.
 */
export function defineMetric(definition: MetricDefinition): void {
  ensure(definition)
}

export function increment(name: string, labels: Labels = {}, by = 1): void {
  const metric = ensure({ name, kind: 'counter', help: name })
  series(metric, labels).value += by
}

export function setGauge(name: string, value: number, labels: Labels = {}): void {
  const metric = ensure({ name, kind: 'gauge', help: name })
  series(metric, labels).value = value
}

export function observe(name: string, value: number, labels: Labels = {}): void {
  const metric = ensure({ name, kind: 'histogram', help: name })
  const s = series(metric, labels)
  s.count += 1
  s.sum += value
  const buckets = metric.definition.buckets ?? DEFAULT_BUCKETS
  for (let i = 0; i < buckets.length; i += 1) {
    const bound = buckets[i]
    if (bound !== undefined && value <= bound) s.bucketCounts[i] = (s.bucketCounts[i] ?? 0) + 1
  }
}

/** Time an async operation into a histogram, recording success or failure. */
export async function timed<T>(
  name: string,
  fn: () => Promise<T> | T,
  labels: Labels = {},
): Promise<T> {
  const started = Date.now()
  try {
    const result = await fn()
    observe(name, Date.now() - started, { ...labels, outcome: 'ok' })
    return result
  } catch (err) {
    observe(name, Date.now() - started, { ...labels, outcome: 'error' })
    throw err
  }
}

export function resetMetrics(): void {
  metrics.clear()
}

function renderLabels(labels: Labels, extra?: Readonly<Record<string, string>>): string {
  const all: Record<string, string> = {}
  for (const [k, v] of Object.entries(labels)) all[k] = String(v)
  if (extra !== undefined) Object.assign(all, extra)
  const keys = Object.keys(all).sort()
  if (keys.length === 0) return ''
  const body = keys
    .map((k) => `${k}="${String(all[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')
  return `{${body}}`
}

/**
 * Render the registry in Prometheus text exposition format. Metric and series
 * names are sorted so a scrape diff is reviewable.
 */
export function renderMetrics(): string {
  const lines: string[] = []
  for (const name of [...metrics.keys()].sort()) {
    const metric = metrics.get(name)
    if (metric === undefined) continue
    const { definition } = metric
    lines.push(`# HELP ${name} ${definition.help}`)
    lines.push(`# TYPE ${name} ${definition.kind}`)
    const keys = [...metric.series.keys()].sort()
    for (const key of keys) {
      const s = metric.series.get(key)
      if (s === undefined) continue
      if (definition.kind === 'histogram') {
        const buckets = definition.buckets ?? DEFAULT_BUCKETS
        for (let i = 0; i < buckets.length; i += 1) {
          const bound = buckets[i]
          if (bound === undefined) continue
          lines.push(
            `${name}_bucket${renderLabels(s.labels, { le: String(bound) })} ${s.bucketCounts[i] ?? 0}`,
          )
        }
        lines.push(`${name}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${s.count}`)
        lines.push(`${name}_sum${renderLabels(s.labels)} ${s.sum}`)
        lines.push(`${name}_count${renderLabels(s.labels)} ${s.count}`)
      } else {
        lines.push(`${name}${renderLabels(s.labels)} ${s.value}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Route handler for `/metrics`.
 *
 * Wire it as `export const GET = metricsHandler` in
 * `src/app/metrics/route.ts`.
 */
export function metricsHandler(): Response {
  return new Response(renderMetrics(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
