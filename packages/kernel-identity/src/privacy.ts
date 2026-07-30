import { publishIdentityEvent } from './events.js'
import { identityRuntime, repository } from './runtime.js'
import { ENTITY } from './schema.js'
import { endAllSessions } from './sessions.js'
import { UserNotFoundError } from './errors.js'
import type {
  Credential,
  EmailVerification,
  PasswordReset,
  Session,
  User,
} from './types.js'

/**
 * Export and deletion handlers named in the `privacy` block of every entity in
 * `owns`. Validation check 10 requires them to exist once `data.privacy` is
 * enabled; they are implemented unconditionally because a subject-access
 * request should not depend on which capabilities a client bought.
 */

export async function exportUser(userId: string): Promise<Record<string, unknown> | null> {
  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: userId })
  if (user === null) return null
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    email_verified_at: user.emailVerifiedAt,
    disabled_at: user.disabledAt,
    created_at: user.createdAt,
  }
}

export async function exportSessions(userId: string): Promise<Record<string, unknown>[]> {
  const sessions = await repository<Session>(ENTITY.session)
  const rows = await sessions.findMany({ userId })
  // No token hashes: exporting them would hand over live credentials.
  return rows.map((session) => ({
    id: session.id,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
    revoked_at: session.revokedAt,
    ip: session.ip,
    user_agent: session.userAgent,
    last_seen_at: session.lastSeenAt,
  }))
}

/** Metadata only. A password hash is never exported, in any form. */
export async function exportCredentialMetadata(
  userId: string,
): Promise<Record<string, unknown>[]> {
  const credentials = await repository<Credential>(ENTITY.credential)
  const rows = await credentials.findMany({ userId })
  return rows.map((credential) => ({
    id: credential.id,
    kind: credential.kind,
    created_at: credential.createdAt,
    rotated_at: credential.rotatedAt,
  }))
}

export async function exportVerifications(userId: string): Promise<Record<string, unknown>[]> {
  const verifications = await repository<EmailVerification>(ENTITY.emailVerification)
  const rows = await verifications.findMany({ userId })
  return rows.map((record) => ({
    id: record.id,
    email: record.email,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    consumed_at: record.consumedAt,
  }))
}

export async function exportResets(userId: string): Promise<Record<string, unknown>[]> {
  const resets = await repository<PasswordReset>(ENTITY.passwordReset)
  const rows = await resets.findMany({ userId })
  return rows.map((record) => ({
    id: record.id,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    consumed_at: record.consumedAt,
    requested_ip: record.requestedIp,
  }))
}

export async function deleteSessions(userId: string): Promise<void> {
  const sessions = await repository<Session>(ENTITY.session)
  for (const session of await sessions.findMany({ userId })) {
    await sessions.softDelete(session.id)
  }
}

export async function deleteCredentials(userId: string): Promise<void> {
  const credentials = await repository<Credential>(ENTITY.credential)
  for (const credential of await credentials.findMany({ userId })) {
    await credentials.softDelete(credential.id)
  }
}

export async function deleteVerifications(userId: string): Promise<void> {
  const verifications = await repository<EmailVerification>(ENTITY.emailVerification)
  for (const record of await verifications.findMany({ userId })) {
    await verifications.softDelete(record.id)
  }
}

export async function deleteResets(userId: string): Promise<void> {
  const resets = await repository<PasswordReset>(ENTITY.passwordReset)
  for (const record of await resets.findMany({ userId })) {
    await resets.softDelete(record.id)
  }
}

/**
 * The User deletion strategy is `anonymize`, not `delete`: audit records and
 * ledger entries reference the actor and must stay intact. The row survives
 * with every identifying field replaced, and everything that could re-identify
 * or re-authenticate it is destroyed.
 */
export async function anonymizeUser(userId: string, reason = 'erasure_request'): Promise<User> {
  const runtime = await identityRuntime()
  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: userId })
  if (user === null) throw new UserNotFoundError(userId)

  const at = runtime.now()
  await endAllSessions(user.id, 'user_anonymized')
  await deleteCredentials(user.id)
  await deleteVerifications(user.id)
  await deleteResets(user.id)
  await deleteSessions(user.id)

  const anonymized = await users.update(user.id, {
    email: `anonymized+${user.id}@invalid`,
    name: null,
    emailVerifiedAt: null,
    disabledAt: at,
    anonymizedAt: at,
  })

  await publishIdentityEvent('identity.user.deleted', { user_id: user.id, reason })
  return anonymized
}
