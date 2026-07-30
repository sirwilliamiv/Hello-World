import { identityConfig } from './config.js'

/** Small response helpers, kept here so no route file needs to repeat them. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export interface CookieOptions {
  maxAgeSeconds: number
}

function serializeCookie(value: string, options: CookieOptions): string {
  const config = identityConfig()
  const parts = [
    `${config.cookieName}=${encodeURIComponent(value)}`,
    `Path=${config.cookiePath}`,
    `Max-Age=${options.maxAgeSeconds}`,
    'HttpOnly',
    `SameSite=${config.cookieSameSite.charAt(0).toUpperCase()}${config.cookieSameSite.slice(1)}`,
  ]
  if (config.cookieSecure) parts.push('Secure')
  return parts.join('; ')
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return serializeCookie(token, { maxAgeSeconds })
}

export function clearedSessionCookie(): string {
  return serializeCookie('', { maxAgeSeconds: 0 })
}
