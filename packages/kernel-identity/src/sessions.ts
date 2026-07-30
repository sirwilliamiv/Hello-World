import { identityConfig } from './config.js'
import { publishIdentityEvent } from './events.js'
import { repository, identityRuntime } from './runtime.js'
import { ENTITY } from './schema.js'
import { generateToken, hashToken } from './tokens.js'
import type { Authentication, Session, User } from './types.js'

export interface StartSessionInput {
  user: User
  ip?: string | null
  userAgent?: string | null
}

export interface StartedSession {
  session: Session
  /** The bearer token. Returned once; only its digest is stored. */
  token: string
}

/** Create a session and publish `identity.session.started`. */
export async function startSession(input: StartSessionInput): Promise<StartedSession> {
  const runtime = await identityRuntime()
  const sessions = await repository<Session>(ENTITY.session)
  const config = identityConfig()
  const token = generateToken()
  const issuedAt = runtime.now()

  const session = await sessions.create({
    userId: input.user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(issuedAt.getTime() + config.sessionTtlMs),
    revokedAt: null,
    revokedReason: null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    lastSeenAt: issuedAt,
  })

  await publishIdentityEvent('identity.session.started', {
    user_id: input.user.id,
    session_id: session.id,
    ...(session.ip !== null ? { ip: session.ip } : {}),
  })

  return { session, token }
}

/**
 * Resolve a bearer token to its user.
 *
 * Every call re-reads the session row and re-checks `revokedAt` and
 * `expiresAt`. There is no cache and no self-contained token (no JWT), which is
 * what makes revocation take effect on the very next request — the smoke test
 * `session revocation is immediate` asserts exactly this.
 */
export async function authenticateToken(token: string | null): Promise<Authentication | null> {
  if (token === null || token === '') return null
  const runtime = await identityRuntime()
  const sessions = await repository<Session>(ENTITY.session)
  const session = await sessions.find({ tokenHash: hashToken(token) })
  if (session === null) return null
  if (session.revokedAt !== null) return null
  if (session.deletedAt !== null) return null
  if (session.expiresAt.getTime() <= runtime.now().getTime()) return null

  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: session.userId })
  if (user === null) return null
  if (user.disabledAt !== null || user.deletedAt !== null) return null

  return { user, session }
}

/** Revoke one session. Idempotent; publishes `identity.session.ended` once. */
export async function endSession(sessionId: string, reason = 'logout'): Promise<void> {
  const runtime = await identityRuntime()
  const sessions = await repository<Session>(ENTITY.session)
  const session = await sessions.find({ id: sessionId })
  if (session === null || session.revokedAt !== null) return

  await sessions.update(session.id, {
    revokedAt: runtime.now(),
    revokedReason: reason,
  })

  await publishIdentityEvent('identity.session.ended', {
    user_id: session.userId,
    session_id: session.id,
    reason,
  })
}

/** Revoke every live session for a user. Used on password reset and on disable. */
export async function endAllSessions(
  userId: string,
  reason: string,
  options: { except?: string } = {},
): Promise<number> {
  const sessions = await repository<Session>(ENTITY.session)
  const live = await sessions.findMany({ userId, revokedAt: null })
  let ended = 0
  for (const session of live) {
    if (options.except !== undefined && session.id === options.except) continue
    await endSession(session.id, reason)
    ended += 1
  }
  return ended
}

/** Sessions belonging to a user, newest first. Backs the account settings surface. */
export async function listSessions(userId: string): Promise<Session[]> {
  const sessions = await repository<Session>(ENTITY.session)
  const rows = await sessions.findMany({ userId })
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}
