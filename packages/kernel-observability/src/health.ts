/**
 * Health.
 *
 * Spec (kernel.observability, exposes.route `health`):
 *   "/health — Liveness and readiness, including database and queue
 *    reachability."
 *
 * kernel.observability declares `requires: []`, so it cannot import
 * `@forge/kernel-data` or the active queue capability to probe them. The
 * relationship is inverted instead: the capability that owns a resource
 * registers a probe for it, exactly as capabilities register nav items into
 * kernel.ui. `database` and `queue` are *required* names — until something
 * registers them the product reports `down`, because a readiness endpoint that
 * says "ready" while nothing has proved the database is reachable is worse than
 * no endpoint at all.
 */

import { logger } from './logger.js'
import { setGauge } from './metrics.js'

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface HealthCheckResult {
  readonly status: HealthStatus
  readonly detail?: string
}

export interface HealthCheck {
  /** Stable name. `database` and `queue` are the two required by the spec. */
  readonly name: string
  /**
   * A failure of a critical check makes the product not ready. Default true.
   */
  readonly critical?: boolean
  /** Default 2000ms. A probe that hangs is a probe that failed. */
  readonly timeoutMs?: number
  readonly check: () => Promise<boolean | HealthCheckResult> | boolean | HealthCheckResult
}

export interface HealthCheckReport {
  readonly status: HealthStatus
  readonly critical: boolean
  readonly durationMs: number
  readonly detail?: string
}

export interface HealthReport {
  readonly status: HealthStatus
  readonly product: string | undefined
  readonly environment: string | undefined
  readonly uptimeMs: number
  readonly checks: Record<string, HealthCheckReport>
}

/**
 * Names every product must be able to answer for. Registered by kernel.data
 * and by whichever work capability is active (kernel.work or its ops.queue
 * upgrade), neither of which this package may import.
 */
export const REQUIRED_CHECKS: readonly string[] = ['database', 'queue']

const checks = new Map<string, HealthCheck>()
let requiredChecks: readonly string[] = REQUIRED_CHECKS
let startedAt = Date.now()
let product: string | undefined
let environment: string | undefined

/** Register a reachability probe. Returns an unregister function. */
export function registerHealthCheck(check: HealthCheck): () => void {
  checks.set(check.name, check)
  return () => {
    if (checks.get(check.name) === check) checks.delete(check.name)
  }
}

export function unregisterHealthCheck(name: string): void {
  checks.delete(name)
}

export function registeredHealthChecks(): readonly string[] {
  return [...checks.keys()].sort()
}

/** Test seam, and the reset `initObservability` performs on re-entry. */
export function resetHealthChecks(): void {
  checks.clear()
  requiredChecks = REQUIRED_CHECKS
  startedAt = Date.now()
  product = undefined
  environment = undefined
}

export function configureHealth(options: {
  product?: string
  environment?: string
  requiredChecks?: readonly string[]
}): void {
  if (options.product !== undefined) product = options.product
  if (options.environment !== undefined) environment = options.environment
  if (options.requiredChecks !== undefined) requiredChecks = options.requiredChecks
  startedAt = Date.now()
}

function normalise(value: boolean | HealthCheckResult): HealthCheckResult {
  if (typeof value === 'boolean') return { status: value ? 'ok' : 'down' }
  return value
}

async function withTimeout(
  check: HealthCheck,
): Promise<HealthCheckResult> {
  const timeoutMs = check.timeoutMs ?? 2000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<HealthCheckResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'down', detail: `probe timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
    })
    const probe = Promise.resolve(check.check()).then(normalise)
    return await Promise.race([probe, timeout])
  } catch (err) {
    return {
      status: 'down',
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run every registered probe and fold the results into one report. */
export async function checkHealth(): Promise<HealthReport> {
  const names = new Set<string>([...requiredChecks, ...checks.keys()])
  const results: Record<string, HealthCheckReport> = {}

  await Promise.all(
    [...names].sort().map(async (name) => {
      const check = checks.get(name)
      const critical = check?.critical ?? true
      if (check === undefined) {
        results[name] = {
          status: 'unknown',
          critical,
          durationMs: 0,
          detail:
            'no probe registered — the capability owning this resource must call registerHealthCheck()',
        }
        return
      }
      const started = Date.now()
      const result = await withTimeout(check)
      results[name] = {
        status: result.status,
        critical,
        durationMs: Date.now() - started,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      }
    }),
  )

  let status: HealthStatus = 'ok'
  for (const [name, result] of Object.entries(results)) {
    const required = requiredChecks.includes(name)
    const isCritical = result.critical || required
    if (result.status === 'ok') continue
    if (isCritical) {
      status = 'down'
      break
    }
    status = 'degraded'
  }

  setGauge('forge_health_status', status === 'ok' ? 1 : 0)
  for (const [name, result] of Object.entries(results)) {
    setGauge('forge_health_check_status', result.status === 'ok' ? 1 : 0, { check: name })
  }

  return {
    status,
    product,
    environment,
    uptimeMs: Date.now() - startedAt,
    checks: results,
  }
}

/**
 * Route handler for `/health`.
 *
 * Wire it as `export const GET = healthHandler` in `src/app/health/route.ts`.
 * `?probe=live` answers liveness only (is the process up), which is what a
 * container orchestrator's restart policy should use; the default is readiness,
 * which is what a load balancer should use.
 */
export async function healthHandler(request?: Request): Promise<Response> {
  const url = request === undefined ? undefined : new URL(request.url)
  const probe = url?.searchParams.get('probe') ?? 'ready'

  if (probe === 'live') {
    return json({ status: 'ok', probe: 'live', uptimeMs: Date.now() - startedAt }, 200)
  }

  const report = await checkHealth()
  if (report.status === 'down') {
    logger.warn('health check not ready', { checks: report.checks })
  }
  return json(report, report.status === 'down' ? 503 : 200)
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
