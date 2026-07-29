/**
 * Spec smoke test: "health endpoint reports ready" —
 *   "/health returns 200 with database and queue reachable".
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  REQUIRED_CHECKS,
  checkHealth,
  configureHealth,
  healthHandler,
  registerHealthCheck,
  resetHealthChecks,
} from '../health.js'
import { renderMetrics, resetMetrics } from '../metrics.js'

function ok(name: string) {
  return registerHealthCheck({ name, check: () => true })
}

describe('/health', () => {
  beforeEach(() => {
    resetHealthChecks()
    resetMetrics()
    configureHealth({ product: 'acme', environment: 'production' })
  })

  it('requires database and queue by name', () => {
    expect(REQUIRED_CHECKS).toEqual(['database', 'queue'])
  })

  it('returns 200 with database and queue reachable', async () => {
    ok('database')
    ok('queue')

    const response = await healthHandler(new Request('https://acme.test/health'))
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      status: string
      product: string
      environment: string
      checks: Record<string, { status: string }>
    }
    expect(body.status).toBe('ok')
    expect(body.product).toBe('acme')
    expect(body.environment).toBe('production')
    expect(body.checks['database']?.status).toBe('ok')
    expect(body.checks['queue']?.status).toBe('ok')
  })

  it('is not ready until something registers the required probes', async () => {
    const response = await healthHandler(new Request('https://acme.test/health'))
    expect(response.status).toBe(503)

    const body = (await response.json()) as { checks: Record<string, { status: string }> }
    // Fail closed: "ready" must never be asserted on an unproven dependency.
    expect(body.checks['database']?.status).toBe('unknown')
    expect(body.checks['queue']?.status).toBe('unknown')
  })

  it('returns 503 when the database is unreachable', async () => {
    registerHealthCheck({
      name: 'database',
      check: () => ({ status: 'down', detail: 'connection refused' }),
    })
    ok('queue')

    const response = await healthHandler(new Request('https://acme.test/health'))
    expect(response.status).toBe(503)

    const body = (await response.json()) as {
      status: string
      checks: Record<string, { status: string; detail?: string }>
    }
    expect(body.status).toBe('down')
    expect(body.checks['database']?.detail).toBe('connection refused')
  })

  it('degrades rather than failing on a non-critical probe', async () => {
    ok('database')
    ok('queue')
    registerHealthCheck({
      name: 'errorTracking',
      critical: false,
      check: () => false,
    })

    const report = await checkHealth()
    expect(report.status).toBe('degraded')

    const response = await healthHandler(new Request('https://acme.test/health'))
    expect(response.status).toBe(200)
  })

  it('treats a probe that throws as down', async () => {
    registerHealthCheck({
      name: 'database',
      check: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    ok('queue')

    const report = await checkHealth()
    expect(report.checks['database']?.status).toBe('down')
    expect(report.checks['database']?.detail).toBe('ECONNREFUSED')
  })

  it('treats a hanging probe as down', async () => {
    registerHealthCheck({
      name: 'database',
      timeoutMs: 10,
      check: () => new Promise<boolean>(() => {}),
    })
    ok('queue')

    const report = await checkHealth()
    expect(report.checks['database']?.status).toBe('down')
    expect(report.checks['database']?.detail).toMatch(/timed out/)
  })

  it('answers liveness without running probes', async () => {
    const response = await healthHandler(new Request('https://acme.test/health?probe=live'))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { probe: string }).probe).toBe('live')
  })

  it('unregisters cleanly', async () => {
    const off = ok('database')
    ok('queue')
    expect((await checkHealth()).status).toBe('ok')
    off()
    expect((await checkHealth()).checks['database']?.status).toBe('unknown')
  })

  it('exports health as a metric', async () => {
    ok('database')
    ok('queue')
    await checkHealth()
    const text = renderMetrics()
    expect(text).toContain('forge_health_status 1')
    expect(text).toContain('forge_health_check_status{check="database"} 1')
  })
})
