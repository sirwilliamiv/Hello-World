import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureIdentity, resetIdentityConfig } from '../src/config.js'
import { authHandler } from '../src/handler.js'
import { resetIdentityRuntime, setIdentityRuntime } from '../src/runtime.js'
import {
  builtInPasswordPolicy,
  passwordPolicyContext,
  postLoginRedirectContext,
  MINIMUM_PASSWORD_LENGTH,
  type IdentitySlots,
  type OnRegistrationSlot,
  type PasswordPolicySlot,
  type PostLoginRedirectSlot,
} from '../src/slots.js'
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

/**
 * schemas/capability.schema.json, `$defs.slot.signature`: every slot context
 * exposes `proceed()`, returning what the capability would have done with no
 * slot implemented. internal/render/render.go seeds exactly this body, so the
 * stubs below are the literal generated text.
 */
describe('the proceed() contract', () => {
  const handlerFor = (slots?: Partial<IdentitySlots>) => {
    const raw = slots === undefined ? authHandler() : authHandler({ slots })
    return (request: Request) => raw(request, { params: Promise.resolve({}) })
  }

  async function registerVerifyLogin(
    handler: (request: Request) => Promise<Response>,
    body: Record<string, unknown> = {},
    login: Record<string, unknown> = {},
  ): Promise<{ registration: Response; redirectTo: string }> {
    const registration = await handler(
      post('register', { email: EMAIL, password: PASSWORD, ...body }),
    )
    if (registration.status !== 201) return { registration, redirectTo: '' }
    const { verification_token } = (await registration.clone().json()) as {
      verification_token: string
    }
    await handler(post('verify-email', { token: verification_token }))
    const loggedIn = await handler(
      post('login', { email: EMAIL, password: PASSWORD, ...login }),
    )
    const { redirect_to } = (await loggedIn.json()) as { redirect_to: string }
    return { registration, redirectTo: redirect_to }
  }

  describe('onRegistration', () => {
    it('proceed() carries on exactly as no slot would: registration completes', async () => {
      const calls: string[] = []
      const onRegistration: OnRegistrationSlot = async (ctx) => {
        calls.push(ctx.user.email)
        return ctx.proceed()
      }

      const { registration } = await registerVerifyLogin(handlerFor({ onRegistration }))
      expect(registration.status).toBe(201)
      // proceed() is the no-op default: nothing happens between the user record
      // and the welcome email, and the event stream is what it is without a slot.
      expect(calls).toEqual([EMAIL])
      expect(runtime.eventNames()).toContain('identity.user.created')
    })

    it('a slot that does more than proceed() changes the outcome', async () => {
      const onRegistration: OnRegistrationSlot = () => {
        throw new Error('invite code required')
      }
      await expect(
        handlerFor({ onRegistration })(post('register', { email: EMAIL, password: PASSWORD })),
      ).rejects.toThrow(/invite code required/)
    })
  })

  describe('passwordPolicy', () => {
    it('proceed() returns the built-in policy result', () => {
      const ctx = passwordPolicyContext({
        password: 'short',
        email: EMAIL,
        user: null,
        reason: 'register',
      })
      expect(ctx.proceed()).toEqual(
        builtInPasswordPolicy({
          password: 'short',
          email: EMAIL,
          user: null,
          reason: 'register',
        }),
      )
      expect(ctx.proceed()).toEqual({
        ok: false,
        reason: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
      })
      expect(
        passwordPolicyContext({
          password: PASSWORD,
          email: EMAIL,
          user: null,
          reason: 'register',
        }).proceed(),
      ).toEqual({ ok: true })
    })

    it('the seeded stub behaves identically to no slot at all', async () => {
      const passwordPolicy: PasswordPolicySlot = async (ctx) => {
        return ctx.proceed()
      }

      // Accepted by the built-in policy, and by the stub.
      expect((await handlerFor({ passwordPolicy })(
        post('register', { email: EMAIL, password: PASSWORD }),
      )).status).toBe(201)

      // Rejected by the built-in policy, and by the stub, with its reason.
      const weak = await handlerFor({ passwordPolicy })(
        post('register', { email: 'grace@example.com', password: 'password' }),
      )
      expect(weak.status).toBe(422)
      expect(((await weak.json()) as { message: string }).message).toBe(
        `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
      )
    })

    it('a slot that tightens proceed() changes the outcome', async () => {
      const passwordPolicy: PasswordPolicySlot = async (ctx) => {
        const builtIn = ctx.proceed()
        if (!builtIn.ok) return builtIn
        return ctx.password.includes('9') ? { ok: true } : { ok: false, reason: 'Needs a nine.' }
      }
      const rejected = await handlerFor({ passwordPolicy })(
        post('register', { email: EMAIL, password: PASSWORD }),
      )
      expect(rejected.status).toBe(422)
      expect(((await rejected.json()) as { message: string }).message).toBe('Needs a nine.')

      expect((await handlerFor({ passwordPolicy })(
        post('register', { email: EMAIL, password: `${PASSWORD}9` }),
      )).status).toBe(201)
    })
  })

  describe('postLoginRedirect', () => {
    it('proceed() returns the requested path, or "/" when there is none', () => {
      const base = { user: {} as never, session: {} as never }
      expect(postLoginRedirectContext({ ...base, requested: null }).proceed()).toBe('/')
      expect(postLoginRedirectContext({ ...base, requested: '/reports' }).proceed()).toBe(
        '/reports',
      )
    })

    it('the seeded stub lands a user where no slot would', async () => {
      const postLoginRedirect: PostLoginRedirectSlot = async (ctx) => {
        return ctx.proceed()
      }
      const withSlot = await registerVerifyLogin(handlerFor({ postLoginRedirect }))
      expect(withSlot.redirectTo).toBe('/')

      // The same handler with no slot at all agrees.
      runtime = createTestRuntime()
      setIdentityRuntime(runtime)
      const without = await registerVerifyLogin(handlerFor())
      expect(without.redirectTo).toBe(withSlot.redirectTo)
    })

    it('a slot returning something else changes where the user lands', async () => {
      const postLoginRedirect: PostLoginRedirectSlot = async (ctx) =>
        ctx.requested === null ? '/dashboard' : ctx.proceed()
      const { redirectTo } = await registerVerifyLogin(handlerFor({ postLoginRedirect }))
      expect(redirectTo).toBe('/dashboard')
    })
  })
})
