import { identityConfig } from './config.js'
import {
  AccountDisabledError,
  EmailInUseError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  InvalidTokenError,
  PasswordRejectedError,
  UserNotFoundError,
} from './errors.js'
import { publishIdentityEvent } from './events.js'
import { hashPassword, needsRehash, verifyPassword } from './password.js'
import { identityRuntime, repository } from './runtime.js'
import { ENTITY } from './schema.js'
import { endAllSessions, startSession } from './sessions.js'
import {
  builtInPasswordPolicy,
  onRegistrationContext,
  passwordPolicyContext,
  postLoginRedirectContext,
  resolveSlots,
  type IdentitySlots,
  type PasswordPolicyInput,
} from './slots.js'
import { generateToken, hashToken } from './tokens.js'
import type {
  Credential,
  EmailVerification,
  PasswordReset,
  Session,
  User,
} from './types.js'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The package's floor policy runs first and cannot be loosened by a client;
 * the slot may then tighten it further.
 */
async function enforcePasswordPolicy(
  slots: Partial<IdentitySlots> | undefined,
  input: PasswordPolicyInput,
): Promise<void> {
  const floor = builtInPasswordPolicy(input)
  if (!floor.ok) throw new PasswordRejectedError(floor.reason)
  // The slot's `ctx.proceed()` returns that same built-in verdict, so the
  // seeded stub reproduces the default path exactly.
  const result = await resolveSlots(slots).passwordPolicy(passwordPolicyContext(input))
  if (!result.ok) throw new PasswordRejectedError(result.reason)
}

async function findUserByEmail(email: string): Promise<User | null> {
  const users = await repository<User>(ENTITY.user)
  return await users.find({ email: normalizeEmail(email) })
}

export interface RegisterInput {
  email: string
  password: string
  name?: string | null
  source?: string | null
  ip?: string | null
  request?: Request | null
}

export interface RegisterResult {
  user: User
  /** Email verification token. Hand this to whatever sends the message. */
  verificationToken: string
  verificationExpiresAt: Date
}

/**
 * Create a user, its password credential, and its first email verification.
 *
 * Publishes `identity.user.created`, which kernel.access consumes to assign the
 * default role. The `onRegistration` slot runs after the record exists and
 * before the welcome email, exactly as the specification declares.
 */
export async function register(
  input: RegisterInput,
  slots?: Partial<IdentitySlots>,
): Promise<RegisterResult> {
  const email = normalizeEmail(input.email)
  if (await findUserByEmail(email)) throw new EmailInUseError(email)

  await enforcePasswordPolicy(slots, {
    password: input.password,
    email,
    user: null,
    reason: 'register',
  })

  const users = await repository<User>(ENTITY.user)
  const credentials = await repository<Credential>(ENTITY.credential)

  const user = await users.create({
    email,
    name: input.name ?? null,
    emailVerifiedAt: null,
    disabledAt: null,
    anonymizedAt: null,
  })

  await credentials.create({
    userId: user.id,
    kind: 'password',
    secret: await hashPassword(input.password),
    rotatedAt: null,
  })

  await publishIdentityEvent('identity.user.created', {
    user_id: user.id,
    email: user.email,
    ...(input.source != null ? { source: input.source } : {}),
  })

  await resolveSlots(slots).onRegistration(
    onRegistrationContext({
      user,
      source: input.source ?? null,
      request: input.request ?? null,
    }),
  )

  const verification = await issueEmailVerification(user)
  return {
    user,
    verificationToken: verification.token,
    verificationExpiresAt: verification.expiresAt,
  }
}

export interface IssuedVerification {
  token: string
  expiresAt: Date
}

/** Issue (or re-issue) an email verification token for a user. */
export async function issueEmailVerification(user: User): Promise<IssuedVerification> {
  const runtime = await identityRuntime()
  const verifications = await repository<EmailVerification>(ENTITY.emailVerification)
  const token = generateToken()
  const expiresAt = new Date(runtime.now().getTime() + identityConfig().emailVerificationTtlMs)
  await verifications.create({
    userId: user.id,
    email: user.email,
    tokenHash: hashToken(token),
    expiresAt,
    consumedAt: null,
  })
  return { token, expiresAt }
}

/** Consume a verification token. Publishes `identity.user.updated`. */
export async function verifyEmail(token: string): Promise<User> {
  const runtime = await identityRuntime()
  const verifications = await repository<EmailVerification>(ENTITY.emailVerification)
  const record = await verifications.find({ tokenHash: hashToken(token) })
  if (record === null || record.consumedAt !== null || record.deletedAt !== null) {
    throw new InvalidTokenError('verification')
  }
  const at = runtime.now()
  if (record.expiresAt.getTime() <= at.getTime()) throw new InvalidTokenError('verification')

  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: record.userId })
  if (user === null) throw new InvalidTokenError('verification')

  await verifications.update(record.id, { consumedAt: at })
  if (user.emailVerifiedAt !== null) return user

  const verified = await users.update(user.id, { emailVerifiedAt: at })
  await publishIdentityEvent('identity.user.updated', {
    user_id: user.id,
    changed: ['email_verified_at'],
  })
  return verified
}

export interface LoginInput {
  email: string
  password: string
  ip?: string | null
  userAgent?: string | null
  /** Same-origin path the user was heading to, passed to `postLoginRedirect`. */
  next?: string | null
}

export interface LoginResult {
  user: User
  session: Session
  token: string
  redirectTo: string
}

/**
 * Verify a password and start a session.
 *
 * Every failure path publishes `identity.login.failed` and raises the same
 * `InvalidCredentialsError`, so the response cannot distinguish "no such
 * account" from "wrong password".
 */
export async function login(
  input: LoginInput,
  slots?: Partial<IdentitySlots>,
): Promise<LoginResult> {
  const email = normalizeEmail(input.email)
  const ip = input.ip ?? null

  const fail = async (reason: string): Promise<never> => {
    await publishIdentityEvent('identity.login.failed', {
      email,
      reason,
      ...(ip !== null ? { ip } : {}),
    })
    if (reason === 'email_unverified') throw new EmailNotVerifiedError()
    if (reason === 'account_disabled') throw new AccountDisabledError()
    throw new InvalidCredentialsError()
  }

  const user = await findUserByEmail(email)
  if (user === null || user.deletedAt !== null) return await fail('unknown_account')
  if (user.disabledAt !== null) return await fail('account_disabled')

  const credentials = await repository<Credential>(ENTITY.credential)
  const credential = await credentials.find({ userId: user.id, kind: 'password' })
  if (credential === null) return await fail('no_password_credential')
  if (!(await verifyPassword(input.password, credential.secret))) {
    return await fail('bad_password')
  }
  if (identityConfig().requireVerifiedEmail && user.emailVerifiedAt === null) {
    return await fail('email_unverified')
  }

  // Transparently upgrade a digest hashed under weaker parameters.
  if (needsRehash(credential.secret)) {
    const runtime = await identityRuntime()
    await credentials.update(credential.id, {
      secret: await hashPassword(input.password),
      rotatedAt: runtime.now(),
    })
  }

  const started = await startSession({ user, ip, userAgent: input.userAgent ?? null })
  const redirectTo = await resolveSlots(slots).postLoginRedirect(
    postLoginRedirectContext({
      user,
      session: started.session,
      requested: sameOriginPath(input.next ?? null),
    }),
  )

  return { user, session: started.session, token: started.token, redirectTo }
}

/** Reject an open redirect before it reaches the slot. */
export function sameOriginPath(candidate: string | null): string | null {
  if (candidate === null || candidate === '') return null
  if (!candidate.startsWith('/')) return null
  if (candidate.startsWith('//')) return null
  return candidate
}

/**
 * Begin a password reset.
 *
 * Returns null when no account matches, and the caller must still report
 * success — an account-enumeration oracle here is as good as a user list.
 */
export async function requestPasswordReset(
  email: string,
  options: { ip?: string | null } = {},
): Promise<{ user: User; token: string; expiresAt: Date } | null> {
  const user = await findUserByEmail(email)
  if (user === null || user.deletedAt !== null || user.disabledAt !== null) return null

  const runtime = await identityRuntime()
  const resets = await repository<PasswordReset>(ENTITY.passwordReset)
  const token = generateToken()
  const expiresAt = new Date(runtime.now().getTime() + identityConfig().passwordResetTtlMs)
  await resets.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
    consumedAt: null,
    requestedIp: options.ip ?? null,
  })

  await publishIdentityEvent('identity.password.reset.requested', { user_id: user.id })
  return { user, token, expiresAt }
}

/**
 * Complete a password reset.
 *
 * Every existing session is revoked: a reset is what a user does when they
 * believe someone else has their password, so leaving that someone else logged
 * in defeats the point.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  slots?: Partial<IdentitySlots>,
): Promise<User> {
  const runtime = await identityRuntime()
  const resets = await repository<PasswordReset>(ENTITY.passwordReset)
  const record = await resets.find({ tokenHash: hashToken(token) })
  if (record === null || record.consumedAt !== null || record.deletedAt !== null) {
    throw new InvalidTokenError('password reset')
  }
  const at = runtime.now()
  if (record.expiresAt.getTime() <= at.getTime()) throw new InvalidTokenError('password reset')

  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: record.userId })
  if (user === null) throw new InvalidTokenError('password reset')

  await enforcePasswordPolicy(slots, {
    password: newPassword,
    email: user.email,
    user,
    reason: 'reset',
  })

  await setPassword(user, newPassword)
  await resets.update(record.id, { consumedAt: at })
  await endAllSessions(user.id, 'password_reset')

  await publishIdentityEvent('identity.user.updated', {
    user_id: user.id,
    changed: ['password'],
  })
  return user
}

/** Change a password for an authenticated user, proving the current one first. */
export async function changePassword(
  user: User,
  currentPassword: string,
  newPassword: string,
  options: { keepSessionId?: string } = {},
  slots?: Partial<IdentitySlots>,
): Promise<void> {
  const credentials = await repository<Credential>(ENTITY.credential)
  const credential = await credentials.find({ userId: user.id, kind: 'password' })
  if (credential === null) throw new InvalidCredentialsError()
  if (!(await verifyPassword(currentPassword, credential.secret))) {
    throw new InvalidCredentialsError()
  }

  await enforcePasswordPolicy(slots, {
    password: newPassword,
    email: user.email,
    user,
    reason: 'change',
  })

  await setPassword(user, newPassword)
  await endAllSessions(user.id, 'password_changed', {
    ...(options.keepSessionId !== undefined ? { except: options.keepSessionId } : {}),
  })
  await publishIdentityEvent('identity.user.updated', {
    user_id: user.id,
    changed: ['password'],
  })
}

async function setPassword(user: User, password: string): Promise<void> {
  const runtime = await identityRuntime()
  const credentials = await repository<Credential>(ENTITY.credential)
  const existing = await credentials.find({ userId: user.id, kind: 'password' })
  const secret = await hashPassword(password)
  if (existing === null) {
    await credentials.create({ userId: user.id, kind: 'password', secret, rotatedAt: null })
    return
  }
  await credentials.update(existing.id, { secret, rotatedAt: runtime.now() })
}

/** Update mutable profile fields. Publishes `identity.user.updated`. */
export async function updateUser(
  userId: string,
  changes: { name?: string | null },
): Promise<User> {
  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: userId })
  if (user === null) throw new UserNotFoundError(userId)

  const changed: string[] = []
  const patch: { name?: string | null } = {}
  if (changes.name !== undefined && changes.name !== user.name) {
    patch.name = changes.name
    changed.push('name')
  }
  if (changed.length === 0) return user

  const updated = await users.update(user.id, patch)
  await publishIdentityEvent('identity.user.updated', { user_id: user.id, changed })
  return updated
}

/** Suspend an account and revoke its sessions immediately. */
export async function disableUser(userId: string, reason = 'disabled'): Promise<User> {
  const runtime = await identityRuntime()
  const users = await repository<User>(ENTITY.user)
  const user = await users.find({ id: userId })
  if (user === null) throw new UserNotFoundError(userId)
  const updated = await users.update(user.id, { disabledAt: runtime.now() })
  await endAllSessions(user.id, reason)
  await publishIdentityEvent('identity.user.updated', {
    user_id: user.id,
    changed: ['disabled_at'],
  })
  return updated
}

export async function getUser(userId: string): Promise<User | null> {
  const users = await repository<User>(ENTITY.user)
  return await users.find({ id: userId })
}
