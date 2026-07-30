/** Runtime configuration. Every value has a safe default; hosts override what they need. */
export interface IdentityConfig {
  /** Name of the cookie carrying the opaque session token. */
  cookieName: string
  cookieSecure: boolean
  cookieSameSite: 'lax' | 'strict' | 'none'
  cookiePath: string
  /** Session lifetime. Revocation is immediate regardless of this value. */
  sessionTtlMs: number
  emailVerificationTtlMs: number
  passwordResetTtlMs: number
  /** When true, an unverified account cannot start a session. */
  requireVerifiedEmail: boolean
  /** Mount point of the generated auth route. Must match the template's output path. */
  basePath: string
  /**
   * Return verification and reset tokens in HTTP responses. Development only —
   * in production the token travels by email and nowhere else.
   */
  exposeTokensInResponses: boolean
  /**
   * How a session token is found outside a request handled by `authHandler` or
   * `AuthGuard` — typically a React Server Component reading `next/headers`.
   * Kept as a hook so this package never imports Next.js.
   */
  sessionTokenResolver: (() => Promise<string | null>) | null
}

const defaults: IdentityConfig = {
  cookieName: 'forge_session',
  cookieSecure: true,
  cookieSameSite: 'lax',
  cookiePath: '/',
  sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
  emailVerificationTtlMs: 1000 * 60 * 60 * 24,
  passwordResetTtlMs: 1000 * 60 * 60,
  requireVerifiedEmail: true,
  basePath: '/auth',
  exposeTokensInResponses: false,
  sessionTokenResolver: null,
}

let current: IdentityConfig = { ...defaults }

export function configureIdentity(patch: Partial<IdentityConfig>): void {
  current = { ...current, ...patch }
}

export function identityConfig(): IdentityConfig {
  return current
}

/** Restore defaults. Exported for tests and for host teardown. */
export function resetIdentityConfig(): void {
  current = { ...defaults }
}
