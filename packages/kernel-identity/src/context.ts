import { AsyncLocalStorage } from 'node:async_hooks'

import { identityConfig } from './config.js'
import { authenticateToken } from './sessions.js'
import type { Authentication, Session, User } from './types.js'

/**
 * Per-request identity context.
 *
 * `authHandler` and `AuthGuard` establish it from the request's cookie; a
 * server component outside either of those falls back to the configured
 * `sessionTokenResolver`. The resolved authentication is memoised for the
 * duration of one request only — across requests every lookup is fresh, which
 * is what keeps revocation immediate.
 */
export interface IdentityRequestContext {
  sessionToken: string | null
  request: Request | null
  resolved: Authentication | null
  didResolve: boolean
}

const storage = new AsyncLocalStorage<IdentityRequestContext>()

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const name = identityConfig().cookieName
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

export function contextFromRequest(request: Request): IdentityRequestContext {
  return {
    sessionToken: readSessionCookie(request),
    request,
    resolved: null,
    didResolve: false,
  }
}

export function runWithIdentityContext<T>(
  context: IdentityRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn)
}

export function identityContext(): IdentityRequestContext | undefined {
  return storage.getStore()
}

/** Resolve the caller for the current request, memoised within that request. */
export async function currentAuthentication(): Promise<Authentication | null> {
  const context = identityContext()
  if (context !== undefined) {
    if (context.didResolve) return context.resolved
    const resolved = await authenticateToken(context.sessionToken)
    context.resolved = resolved
    context.didResolve = true
    return resolved
  }

  // No ambient context: a server component, a job, or a test calling directly.
  const resolver = identityConfig().sessionTokenResolver
  if (resolver === null) return null
  return await authenticateToken(await resolver())
}

/**
 * `currentUser(): Promise<User | null>` — the interface declared in the
 * specification's `exposes` block, and the one every other capability calls.
 */
export async function currentUser(): Promise<User | null> {
  const authentication = await currentAuthentication()
  return authentication?.user ?? null
}

/** The session backing the current request, if any. */
export async function currentSession(): Promise<Session | null> {
  const authentication = await currentAuthentication()
  return authentication?.session ?? null
}
