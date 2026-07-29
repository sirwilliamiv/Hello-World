import type { Session, User } from './types.js'

/**
 * Slot types for kernel.identity.
 *
 * The generated stubs in `src/slots/kernel.identity/` import these types, so
 * they live here and upgrade with the package: a major version that changes a
 * signature breaks the client's build loudly and locally (ARCHITECTURE.md §4).
 */

export interface OnRegistrationContext {
  user: User
  /** Where the registration came from — 'self_service', an invite code, an IdP. */
  source: string | null
  /** Present when registration arrived over HTTP. */
  request: Request | null
}

/**
 * Runs after the user record is created and before the welcome email.
 * Client-specific onboarding: default records, external enrolment, invite-code
 * redemption. Throwing aborts the request; the user record is already written,
 * so throw only for conditions worth failing the registration over.
 */
export type OnRegistrationSlot = (ctx: OnRegistrationContext) => void | Promise<void>

export interface PasswordPolicyContext {
  password: string
  email: string
  /** The user the password is being set for; null during registration. */
  user: User | null
  /** 'register' | 'reset' | 'change' */
  reason: 'register' | 'reset' | 'change'
}

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string }

/** Runs on every password set or change. Client-specific complexity and reuse rules. */
export type PasswordPolicySlot = (
  ctx: PasswordPolicyContext,
) => PasswordPolicyResult | Promise<PasswordPolicyResult>

export interface PostLoginRedirectContext {
  user: User
  session: Session
  /** The `next` parameter of the login request, already same-origin checked. */
  requested: string | null
}

/** Runs after a successful login. Where a user lands, which is usually role-dependent. */
export type PostLoginRedirectSlot = (
  ctx: PostLoginRedirectContext,
) => string | Promise<string>

/** The slot namespace `authHandler` receives from the generated route. */
export interface IdentitySlots {
  onRegistration: OnRegistrationSlot
  passwordPolicy: PasswordPolicySlot
  postLoginRedirect: PostLoginRedirectSlot
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'passw0rd',
  '12345678',
  '123456789',
  'qwertyuiop',
  'letmein123',
  'iloveyou123',
  'administrator',
])

/** Minimum length; the slot may tighten this but not loosen it below 8. */
export const MINIMUM_PASSWORD_LENGTH = 12

/**
 * The policy applied when a client has not implemented `passwordPolicy`, and
 * the floor applied before any client policy runs.
 */
export const defaultPasswordPolicy: PasswordPolicySlot = (ctx) => {
  const password = ctx.password.normalize('NFKC')
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` }
  }
  if (password.length > 512) {
    return { ok: false, reason: 'Password must be at most 512 characters.' }
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'That password is too common.' }
  }
  const local = ctx.email.split('@')[0] ?? ''
  if (local.length >= 3 && password.toLowerCase().includes(local.toLowerCase())) {
    return { ok: false, reason: 'Password must not contain your email address.' }
  }
  return { ok: true }
}

export const defaultOnRegistration: OnRegistrationSlot = () => {
  // Nothing by default. The seeded stub is where client onboarding goes.
}

export const defaultPostLoginRedirect: PostLoginRedirectSlot = (ctx) => ctx.requested ?? '/'

export function resolveSlots(slots: Partial<IdentitySlots> | undefined): IdentitySlots {
  return {
    onRegistration: slots?.onRegistration ?? defaultOnRegistration,
    passwordPolicy: slots?.passwordPolicy ?? defaultPasswordPolicy,
    postLoginRedirect: slots?.postLoginRedirect ?? defaultPostLoginRedirect,
  }
}
