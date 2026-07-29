import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureIdentity, resetIdentityConfig } from '../src/config.js'
import { authHandler } from '../src/handler.js'
import { resetIdentityRuntime, setIdentityRuntime } from '../src/runtime.js'
import type { OnRegistrationSlot, PasswordPolicySlot, PostLoginRedirectSlot } from '../src/slots.js'
import { createTestRuntime, type TestRuntime } from './support/fakes.js'

/**
 * tests.smoke: "register, verify, log in, log out" —
 * asserts the full credential lifecycle works end to end.
 *
 * Driven through `authHandler`, which is the call site the generated route in
 * templates/kernel.identity/auth-routes.ts.tmpl pins.
 */

const EMAIL = 'ada@example.com'
const PASSWORD = 'correct-horse-battery-staple'

let runtime: TestRuntime

function post(action: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers['cookie'] = cookie
  return new Request(`https://acme.example.com/auth/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function get(action: string, cookie?: string): Request {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers['cookie'] = cookie
  return new Request(`https://acme.example.com/auth/${action}`, { method: 'GET', headers })
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

beforeEach(() => {
  runtime = createTestRuntime()
  setIdentityRuntime(runtime)
  resetIdentityConfig()
  // Tokens normally travel by email; surfacing them is a development-only affordance.
  configureIdentity({ exposeTokensInResponses: true, cookieSecure: false })
})

afterEach(() => {
  resetIdentityRuntime()
  resetIdentityConfig()
})

describe('register, verify, log in, log out', () => {
  it('runs the full credential lifecycle', async () => {
    const raw = authHandler()
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })

    // ── register ────────────────────────────────────────────────────────────
    const registered = await handler(post('register', { email: EMAIL, password: PASSWORD }))
    expect(registered.status).toBe(201)
    const registration = (await registered.json()) as {
      user_id: string
      verification_token: string
    }
    expect(registration.user_id).toBeTruthy()
    expect(runtime.eventNames()).toContain('identity.user.created')

    // An unverified account cannot start a session.
    const premature = await handler(post('login', { email: EMAIL, password: PASSWORD }))
    expect(premature.status).toBe(403)
    expect(((await premature.json()) as { error: string }).error).toBe('email_not_verified')

    // ── verify ──────────────────────────────────────────────────────────────
    const verified = await handler(
      post('verify-email', { token: registration.verification_token }),
    )
    expect(verified.status).toBe(200)
    expect(runtime.eventNames()).toContain('identity.user.updated')

    // A verification token is single-use.
    const replayed = await handler(post('verify-email', { token: registration.verification_token }))
    expect(replayed.status).toBe(400)

    // ── log in ──────────────────────────────────────────────────────────────
    const loggedIn = await handler(post('login', { email: EMAIL, password: PASSWORD }))
    expect(loggedIn.status).toBe(200)
    const cookie = cookieFrom(loggedIn)
    expect(cookie).toMatch(/^forge_session=/)
    expect(runtime.eventNames()).toContain('identity.session.started')
    expect(((await loggedIn.json()) as { redirect_to: string }).redirect_to).toBe('/')

    // The session authenticates a subsequent request.
    const whoami = await handler(get('session', cookie))
    const identity = (await whoami.json()) as { authenticated: boolean; user: { email: string } }
    expect(identity.authenticated).toBe(true)
    expect(identity.user.email).toBe(EMAIL)

    // ── log out ─────────────────────────────────────────────────────────────
    const loggedOut = await handler(post('logout', {}, cookie))
    expect(loggedOut.status).toBe(200)
    expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(runtime.eventNames()).toContain('identity.session.ended')

    const after = await handler(get('session', cookie))
    expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false)
  })

  it('publishes identity.login.failed and never distinguishes the failure', async () => {
    const raw = authHandler()
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })
    await handler(post('register', { email: EMAIL, password: PASSWORD }))

    const unknown = await handler(post('login', { email: 'nobody@example.com', password: PASSWORD }))
    const wrong = await handler(post('login', { email: EMAIL, password: 'wrong-password-here' }))

    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await unknown.json()).toEqual(await wrong.json())
    expect(runtime.events.filter((event) => event.name === 'identity.login.failed')).toHaveLength(2)
  })

  it('rejects a duplicate email and a password below the floor policy', async () => {
    const raw = authHandler()
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })
    await handler(post('register', { email: EMAIL, password: PASSWORD }))

    const duplicate = await handler(post('register', { email: ' ADA@example.com ', password: PASSWORD }))
    expect(duplicate.status).toBe(409)

    const weak = await handler(post('register', { email: 'new@example.com', password: 'short' }))
    expect(weak.status).toBe(422)
  })

  it('resets a password by token and revokes every existing session', async () => {
    const raw = authHandler()
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })
    const registered = await handler(post('register', { email: EMAIL, password: PASSWORD }))
    const { verification_token } = (await registered.json()) as { verification_token: string }
    await handler(post('verify-email', { token: verification_token }))

    const loggedIn = await handler(post('login', { email: EMAIL, password: PASSWORD }))
    const cookie = cookieFrom(loggedIn)

    const forgot = await handler(post('password/forgot', { email: EMAIL }))
    const { reset_token } = (await forgot.json()) as { reset_token: string }
    expect(runtime.eventNames()).toContain('identity.password.reset.requested')

    const NEW_PASSWORD = 'a-different-long-password'
    const reset = await handler(post('password/reset', { token: reset_token, password: NEW_PASSWORD }))
    expect(reset.status).toBe(200)

    // The session that existed before the reset is gone.
    const stale = await handler(get('session', cookie))
    expect(((await stale.json()) as { authenticated: boolean }).authenticated).toBe(false)

    // The old password no longer works; the new one does.
    expect((await handler(post('login', { email: EMAIL, password: PASSWORD }))).status).toBe(401)
    expect((await handler(post('login', { email: EMAIL, password: NEW_PASSWORD }))).status).toBe(200)
  })

  it('does not reveal whether an address has an account', async () => {
    const raw = authHandler()
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })
    const response = await handler(post('password/forgot', { email: 'nobody@example.com' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})

describe('slots', () => {
  it('runs onRegistration, tightens the password policy, and chooses the redirect', async () => {
    const seen: string[] = []

    const onRegistration: OnRegistrationSlot = (ctx) => {
      seen.push(`onRegistration:${ctx.user.email}:${ctx.source ?? 'none'}`)
    }
    const passwordPolicy: PasswordPolicySlot = (ctx) =>
      ctx.password.includes('!') ? { ok: true } : { ok: false, reason: 'Needs a bang.' }
    const postLoginRedirect: PostLoginRedirectSlot = () => '/dashboard'

    const raw = authHandler({ slots: { onRegistration, passwordPolicy, postLoginRedirect } })
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })

    const rejected = await handler(post('register', { email: EMAIL, password: PASSWORD }))
    expect(rejected.status).toBe(422)
    expect(((await rejected.json()) as { message: string }).message).toBe('Needs a bang.')

    const accepted = await handler(
      post('register', { email: EMAIL, password: `${PASSWORD}!`, source: 'invite' }),
    )
    expect(accepted.status).toBe(201)
    expect(seen).toEqual([`onRegistration:${EMAIL}:invite`])

    const { verification_token } = (await accepted.json()) as { verification_token: string }
    await handler(post('verify-email', { token: verification_token }))
    const loggedIn = await handler(post('login', { email: EMAIL, password: `${PASSWORD}!` }))
    expect(((await loggedIn.json()) as { redirect_to: string }).redirect_to).toBe('/dashboard')
  })

  it('applies the package floor policy before any client slot', async () => {
    // A slot that approves everything still cannot approve a 5-character password.
    const passwordPolicy: PasswordPolicySlot = () => ({ ok: true })
    const raw = authHandler({ slots: { passwordPolicy } })
    const handler = (request: Request) => raw(request, { params: Promise.resolve({}) })
    const response = await handler(post('register', { email: EMAIL, password: 'short' }))
    expect(response.status).toBe(422)
  })
})
