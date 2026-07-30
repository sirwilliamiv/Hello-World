import {
  configureIdentity,
  identityConfig,
  login,
  register,
  resetIdentityConfig,
  resetIdentityRuntime,
  setIdentityRuntime,
  verifyEmail,
} from '@forge/kernel-identity'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assignDefaultRole, grantRole } from '../src/assignments.js'
import { configureAccess, resetAccessConfig } from '../src/config.js'
import { RequirePermission } from '../src/guard.js'
import { permissions, registerPermission } from '../src/permissions.js'
import { resetAccessRuntime, setAccessRuntime } from '../src/runtime.js'
import type { RouteHandler } from '../src/types.js'
import { createTestRuntime, type TestRuntime } from './support/fakes.js'

/**
 * tests.smoke: "guard denies without permission" —
 * asserts a protected route returns 403 for a user lacking the declared
 * permission.
 */

const PASSWORD = 'correct-horse-battery-staple'

let runtime: TestRuntime

const protectedRoute: RouteHandler = async () =>
  new Response(JSON.stringify({ refunded: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  const registered = await register({ email, password: PASSWORD })
  await verifyEmail(registered.verificationToken)
  const session = await login({ email, password: PASSWORD })
  return {
    cookie: `${identityConfig().cookieName}=${session.token}`,
    userId: registered.user.id,
  }
}

function request(cookie?: string): Request {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers['cookie'] = cookie
  return new Request('https://acme.example.com/api/payments/refund', { method: 'POST', headers })
}

beforeEach(() => {
  runtime = createTestRuntime()
  setAccessRuntime(runtime)
  setIdentityRuntime(runtime)
  resetAccessConfig()
  resetIdentityConfig()
  configureIdentity({ cookieSecure: false })
  permissions.clear()
  runtime.subscribe('identity.user.created', assignDefaultRole)
  // As the generated permissions file does, from pay.card's `registers` block.
  registerPermission({ action: 'payment.refund', defaultRoles: ['owner'] })
})

afterEach(() => {
  resetAccessRuntime()
  resetIdentityRuntime()
  resetAccessConfig()
  resetIdentityConfig()
  permissions.clear()
})

describe('guard denies without permission', () => {
  it('returns 403 for an authenticated user lacking the permission', async () => {
    const { cookie } = await signIn('member@example.com') // gets the default role, member

    const guarded = RequirePermission('payment.refund')(protectedRoute)
    const response = await guarded(request(cookie), { params: Promise.resolve({}) })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden', action: 'payment.refund' })
  })

  it('returns 401 when no session backs the request', async () => {
    const guarded = RequirePermission('payment.refund')(protectedRoute)
    const response = await guarded(request(), { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'not_authenticated' })
  })

  it('lets the request through once the user holds a granting role', async () => {
    const { cookie, userId } = await signIn('owner@example.com')
    await grantRole(userId, 'owner')

    const guarded = RequirePermission('payment.refund')(protectedRoute)
    const response = await guarded(request(cookie), { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ refunded: true })
  })

  it('denies immediately after the granting role is taken away mid-session', async () => {
    const { cookie, userId } = await signIn('demoted@example.com')
    await grantRole(userId, 'owner')

    const guarded = RequirePermission('payment.refund')(protectedRoute)
    expect((await guarded(request(cookie), { params: Promise.resolve({}) })).status).toBe(200)

    const { revokeRole } = await import('../src/assignments.js')
    await revokeRole(userId, 'owner')

    // Same session, same cookie: authorisation is re-evaluated per request.
    expect((await guarded(request(cookie), { params: Promise.resolve({}) })).status).toBe(403)
  })

  it('resolves the resource from the request when given a resolver', async () => {
    const { cookie, userId } = await signIn('scoped@example.com')
    await grantRole(userId, 'owner', { scope: 'org_a' })

    const guarded = RequirePermission('payment.refund', () => ({
      type: 'Payment',
      scope: 'org_b',
    }))(protectedRoute)

    expect((await guarded(request(cookie), { params: Promise.resolve({}) })).status).toBe(403)

    const inScope = RequirePermission('payment.refund', () => ({
      type: 'Payment',
      scope: 'org_a',
    }))(protectedRoute)

    expect((await inScope(request(cookie), { params: Promise.resolve({}) })).status).toBe(200)
  })

  it('applies the permissionResolver slot to a guarded route', async () => {
    const { cookie } = await signIn('slotted@example.com')
    configureAccess({
      slots: { permissionResolver: (ctx) => ctx.action === 'payment.refund' },
    })

    const guarded = RequirePermission('payment.refund')(protectedRoute)
    expect((await guarded(request(cookie), { params: Promise.resolve({}) })).status).toBe(200)
  })
})
