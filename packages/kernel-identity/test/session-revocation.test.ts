import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureIdentity, identityConfig, resetIdentityConfig } from '../src/config.js'
import { currentUser } from '../src/context.js'
import { AuthGuard, withIdentity } from '../src/guard.js'
import { json } from '../src/http.js'
import { resetIdentityRuntime, setIdentityRuntime } from '../src/runtime.js'
import { authenticateToken, endAllSessions, endSession } from '../src/sessions.js'
import { login, register, verifyEmail } from '../src/users.js'
import { createTestRuntime, type TestRuntime } from './support/fakes.js'

/**
 * tests.smoke: "session revocation is immediate" —
 * asserts an ended session cannot authenticate a subsequent request.
 *
 * The property this protects is the reason sessions are opaque database-backed
 * tokens rather than self-contained ones: nothing about a session is trusted
 * without re-reading the row.
 */

const EMAIL = 'grace@example.com'
const PASSWORD = 'correct-horse-battery-staple'

let runtime: TestRuntime

async function verifiedUser(): Promise<{ token: string; userId: string; sessionId: string }> {
  const registered = await register({ email: EMAIL, password: PASSWORD })
  await verifyEmail(registered.verificationToken)
  const session = await login({ email: EMAIL, password: PASSWORD })
  return { token: session.token, userId: registered.user.id, sessionId: session.session.id }
}

beforeEach(() => {
  runtime = createTestRuntime()
  setIdentityRuntime(runtime)
  resetIdentityConfig()
  configureIdentity({ cookieSecure: false })
})

afterEach(() => {
  resetIdentityRuntime()
  resetIdentityConfig()
})

describe('session revocation is immediate', () => {
  it('refuses the very next request after the session ends', async () => {
    const { token, sessionId } = await verifiedUser()

    expect(await authenticateToken(token)).not.toBeNull()

    await endSession(sessionId, 'logout')

    // No clock advance, no cache eviction, no re-login: the next call fails.
    expect(await authenticateToken(token)).toBeNull()
    expect(runtime.eventNames()).toContain('identity.session.ended')
  })

  it('refuses a guarded route immediately after revocation', async () => {
    const { token, sessionId } = await verifiedUser()
    const guarded = AuthGuard(async () => json({ ok: true }))
    const cookie = `${identityConfig().cookieName}=${token}`
    const request = (): Request =>
      new Request('https://acme.example.com/api/private', { headers: { cookie } })

    expect((await guarded(request(), { params: Promise.resolve({}) })).status).toBe(200)

    await endSession(sessionId, 'revoked_by_admin')

    const denied = await guarded(request(), { params: Promise.resolve({}) })
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({ error: 'not_authenticated' })
  })

  it('revokes every session for a user at once', async () => {
    await verifiedUser()
    const second = await login({ email: EMAIL, password: PASSWORD })
    const third = await login({ email: EMAIL, password: PASSWORD })

    const ended = await endAllSessions(second.user.id, 'password_reset')
    expect(ended).toBe(3)
    expect(await authenticateToken(second.token)).toBeNull()
    expect(await authenticateToken(third.token)).toBeNull()
  })

  it('is idempotent: ending an already-ended session publishes once', async () => {
    const { sessionId } = await verifiedUser()
    await endSession(sessionId, 'logout')
    await endSession(sessionId, 'logout')
    expect(
      runtime.events.filter((event) => event.name === 'identity.session.ended'),
    ).toHaveLength(1)
  })

  it('refuses an expired session without any revocation', async () => {
    const { token } = await verifiedUser()
    runtime.advance(identityConfig().sessionTtlMs + 1)
    expect(await authenticateToken(token)).toBeNull()
  })

  it('refuses a session whose user has been disabled or anonymised', async () => {
    const { token, userId } = await verifiedUser()
    const users = runtime.repository<{ id: string; disabledAt: Date | null }>('User')
    await users.update(userId, { disabledAt: runtime.now() })
    expect(await authenticateToken(token)).toBeNull()
  })

  it('resolves currentUser() only inside a request context', async () => {
    const { token } = await verifiedUser()
    const cookie = `${identityConfig().cookieName}=${token}`

    expect(await currentUser()).toBeNull()

    const inside = await withIdentity(
      new Request('https://acme.example.com/x', { headers: { cookie } }),
      async () => await currentUser(),
    )
    expect(inside?.email).toBe(EMAIL)
  })
})
