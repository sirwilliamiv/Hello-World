import { z } from 'zod'

import { identityConfig } from './config.js'
import { currentAuthentication } from './context.js'
import { IdentityError } from './errors.js'
import { withIdentity } from './guard.js'
import { clearedSessionCookie, json, sessionCookie } from './http.js'
import { endSession, listSessions } from './sessions.js'
import type { IdentitySlots } from './slots.js'
import type { RouteHandler } from './types.js'
import {
  changePassword,
  issueEmailVerification,
  login,
  register,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from './users.js'

/**
 * The auth route, mounted by templates/kernel.identity/auth-routes.ts.tmpl:
 *
 *   const handler = authHandler({ slots })
 *   export const GET = handler
 *   export const POST = handler
 *
 * Ten lines of generated wiring; everything below upgrades with the package.
 */
export interface AuthHandlerOptions {
  /**
   * The client's slot implementations — `import * as slots from
   * '@/slots/kernel.identity'`. Any slot the client has not implemented falls
   * back to this package's default.
   */
  slots?: Partial<IdentitySlots>
  /** Override the mount point when it differs from the default `/auth`. */
  basePath?: string
}

const emailSchema = z.string().trim().min(3).max(320).email()
const passwordSchema = z.string().min(1).max(512)

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().max(100).optional(),
})

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  next: z.string().max(2048).optional(),
})

const verifySchema = z.object({ token: z.string().min(1).max(512) })

const forgotSchema = z.object({ email: emailSchema })

const resetSchema = z.object({
  token: z.string().min(1).max(512),
  password: passwordSchema,
})

const changeSchema = z.object({
  current_password: passwordSchema,
  new_password: passwordSchema,
})

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return await request.json()
  }
  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    return Object.fromEntries((await request.formData()).entries())
  }
  return {}
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded !== null && forwarded !== '') {
    return (forwarded.split(',')[0] ?? '').trim() || null
  }
  return request.headers.get('x-real-ip')
}

function segment(request: Request, basePath: string): string {
  const path = new URL(request.url).pathname
  const trimmed = path.startsWith(basePath) ? path.slice(basePath.length) : path
  return trimmed.replace(/^\/+|\/+$/g, '')
}

export function authHandler(options: AuthHandlerOptions = {}): RouteHandler {
  const slots = options.slots

  return async (request) =>
    await withIdentity(request, async () => {
      const config = identityConfig()
      const basePath = options.basePath ?? config.basePath
      const action = segment(request, basePath)
      const method = request.method.toUpperCase()

      try {
        // GET /auth/verify-email?token=… — the link in a verification email.
        if (method === 'GET' && action === 'verify-email') {
          const token = new URL(request.url).searchParams.get('token') ?? ''
          const user = await verifyEmail(token)
          return json({ ok: true, user_id: user.id, email_verified: true })
        }

        // GET /auth/session — who am I?
        if (method === 'GET' && action === 'session') {
          const authentication = await currentAuthentication()
          if (authentication === null) return json({ authenticated: false }, 200)
          return json({
            authenticated: true,
            user: {
              id: authentication.user.id,
              email: authentication.user.email,
              name: authentication.user.name,
              email_verified: authentication.user.emailVerifiedAt !== null,
            },
            session_id: authentication.session.id,
          })
        }

        // GET /auth/sessions — this user's sessions, for the account surface.
        if (method === 'GET' && action === 'sessions') {
          const authentication = await currentAuthentication()
          if (authentication === null) return json({ error: 'not_authenticated' }, 401)
          const sessions = await listSessions(authentication.user.id)
          return json({
            sessions: sessions.map((session) => ({
              id: session.id,
              created_at: session.createdAt.toISOString(),
              expires_at: session.expiresAt.toISOString(),
              revoked: session.revokedAt !== null,
              current: session.id === authentication.session.id,
              ip: session.ip,
              user_agent: session.userAgent,
            })),
          })
        }

        if (method !== 'POST') {
          return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' })
        }

        const body = await readJson(request)

        switch (action) {
          case 'register': {
            const input = registerSchema.parse(body)
            const result = await register(
              {
                email: input.email,
                password: input.password,
                name: input.name ?? null,
                source: input.source ?? 'self_service',
                ip: clientIp(request),
                request,
              },
              slots,
            )
            return json(
              {
                ok: true,
                user_id: result.user.id,
                email_verification_required: true,
                ...(config.exposeTokensInResponses
                  ? { verification_token: result.verificationToken }
                  : {}),
              },
              201,
            )
          }

          case 'verify-email': {
            const input = verifySchema.parse(body)
            const user = await verifyEmail(input.token)
            return json({ ok: true, user_id: user.id, email_verified: true })
          }

          case 'resend-verification': {
            const authentication = await currentAuthentication()
            if (authentication === null) return json({ error: 'not_authenticated' }, 401)
            const issued = await issueEmailVerification(authentication.user)
            return json({
              ok: true,
              ...(config.exposeTokensInResponses ? { verification_token: issued.token } : {}),
            })
          }

          case 'login': {
            const input = loginSchema.parse(body)
            const result = await login(
              {
                email: input.email,
                password: input.password,
                next: input.next ?? null,
                ip: clientIp(request),
                userAgent: request.headers.get('user-agent'),
              },
              slots,
            )
            return json(
              {
                ok: true,
                user_id: result.user.id,
                session_id: result.session.id,
                redirect_to: result.redirectTo,
              },
              200,
              {
                'set-cookie': sessionCookie(
                  result.token,
                  Math.floor(config.sessionTtlMs / 1000),
                ),
              },
            )
          }

          case 'logout': {
            const authentication = await currentAuthentication()
            if (authentication !== null) {
              await endSession(authentication.session.id, 'logout')
            }
            // Always clears the cookie, so a stale token cannot linger.
            return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() })
          }

          case 'password/forgot': {
            const input = forgotSchema.parse(body)
            const issued = await requestPasswordReset(input.email, { ip: clientIp(request) })
            // Same response whether or not the account exists.
            return json({
              ok: true,
              ...(config.exposeTokensInResponses && issued !== null
                ? { reset_token: issued.token }
                : {}),
            })
          }

          case 'password/reset': {
            const input = resetSchema.parse(body)
            const user = await resetPassword(input.token, input.password, slots)
            return json({ ok: true, user_id: user.id }, 200, {
              'set-cookie': clearedSessionCookie(),
            })
          }

          case 'password/change': {
            const authentication = await currentAuthentication()
            if (authentication === null) return json({ error: 'not_authenticated' }, 401)
            const input = changeSchema.parse(body)
            await changePassword(
              authentication.user,
              input.current_password,
              input.new_password,
              { keepSessionId: authentication.session.id },
              slots,
            )
            return json({ ok: true })
          }

          default:
            return json({ error: 'not_found', action }, 404)
        }
      } catch (error) {
        if (error instanceof IdentityError) {
          return json({ error: error.code, message: error.message }, error.status)
        }
        if (error instanceof z.ZodError) {
          return json({ error: 'invalid_request', issues: error.issues }, 422)
        }
        throw error
      }
    })
}
