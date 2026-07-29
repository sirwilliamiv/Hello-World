import type { Session, User } from './types.js'

/**
 * Slot types for kernel.identity.
 *
 * The generated stubs in `src/slots/kernel.identity/` import these types, so
 * they live here and upgrade with the package: a major version that changes a
 * signature breaks the client's build loudly and locally (ARCHITECTURE.md §4).
 *
 * Every slot takes a single context object, and that context exposes
 * `proceed()`, returning whatever this capability would have done with no slot
 * implemented (schemas/capability.schema.json, `$defs.slot.signature`). That is
 * what lets Forge seed a stub which compiles and behaves correctly before
 * anyone has written anything:
 *
 *     export const passwordPolicy: PasswordPolicySlot = async (ctx) => {
 *       return ctx.proceed()
 *     }
 */

/* ------------------------------------------------------------ onRegistration */

export interface OnRegistrationInput {
  readonly user: User
  /** Where the registration came from — 'self_service', an invite code, an IdP. */
  readonly source: string | null
  /** Present when registration arrived over HTTP. */
  readonly request: Request | null
}

export interface OnRegistrationContext extends OnRegistrationInput {
  /**
   * Carry on as registration would have with no slot implemented: nothing
   * happens between the user record being written and the welcome email.
   */
  proceed(): void
}

/**
 * Runs after the user record is created and before the welcome email.
 * Client-specific onboarding: default records, external enrolment, invite-code
 * redemption. Throwing aborts the request; the user record is already written,
 * so throw only for conditions worth failing the registration over.
 */
export type OnRegistrationSlot = (ctx: OnRegistrationContext) => void | Promise<void>

/* ------------------------------------------------------------ passwordPolicy */

export interface PasswordPolicyInput {
  readonly password: string
  readonly email: string
  /** The user the password is being set for; null during registration. */
  readonly user: User | null
  readonly reason: 'register' | 'reset' | 'change'
}

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string }

export interface PasswordPolicyContext extends PasswordPolicyInput {
  /**
   * The built-in policy's verdict on this password: length floor, the common
   * password list, and the email-substring rule. That is what the capability
   * decides with no slot implemented, and it is also the floor — the package
   * applies it before the slot runs, so a slot can tighten it but not loosen
   * it.
   */
  proceed(): PasswordPolicyResult
}

/** Runs on every password set or change. Client-specific complexity and reuse rules. */
export type PasswordPolicySlot = (
  ctx: PasswordPolicyContext,
) => PasswordPolicyResult | Promise<PasswordPolicyResult>

/* --------------------------------------------------------- postLoginRedirect */

export interface PostLoginRedirectInput {
  readonly user: User
  readonly session: Session
  /** The `next` parameter of the login request, already same-origin checked. */
  readonly requested: string | null
}

export interface PostLoginRedirectContext extends PostLoginRedirectInput {
  /** Where login sends a user with no slot implemented: `requested ?? '/'`. */
  proceed(): string
}

/** Runs after a successful login. Where a user lands, which is usually role-dependent. */
export type PostLoginRedirectSlot = (
  ctx: PostLoginRedirectContext,
) => string | Promise<string>

/* --------------------------------------------------------------------------- */

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
 * the floor applied before any client policy runs. `ctx.proceed()` returns
 * exactly this.
 */
export function builtInPasswordPolicy(input: PasswordPolicyInput): PasswordPolicyResult {
  const password = input.password.normalize('NFKC')
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` }
  }
  if (password.length > 512) {
    return { ok: false, reason: 'Password must be at most 512 characters.' }
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'That password is too common.' }
  }
  const local = input.email.split('@')[0] ?? ''
  if (local.length >= 3 && password.toLowerCase().includes(local.toLowerCase())) {
    return { ok: false, reason: 'Password must not contain your email address.' }
  }
  return { ok: true }
}

/* ---------------------------------------------------------- context builders */

/**
 * The call sites in users.ts build their context through these, so each
 * `proceed()` is defined once and cannot drift from the path taken when the
 * slot is absent.
 */

export function onRegistrationContext(input: OnRegistrationInput): OnRegistrationContext {
  return {
    ...input,
    proceed: (): void => {
      // The default: no client-specific onboarding runs.
    },
  }
}

export function passwordPolicyContext(input: PasswordPolicyInput): PasswordPolicyContext {
  return { ...input, proceed: () => builtInPasswordPolicy(input) }
}

export function postLoginRedirectContext(
  input: PostLoginRedirectInput,
): PostLoginRedirectContext {
  return { ...input, proceed: () => input.requested ?? '/' }
}

/* ----------------------------------------------------------------- defaults */

/** Identical to the seeded stub: carry on as the capability would have. */
export const defaultOnRegistration: OnRegistrationSlot = (ctx) => ctx.proceed()
export const defaultPasswordPolicy: PasswordPolicySlot = (ctx) => ctx.proceed()
export const defaultPostLoginRedirect: PostLoginRedirectSlot = (ctx) => ctx.proceed()

export function resolveSlots(slots: Partial<IdentitySlots> | undefined): IdentitySlots {
  return {
    onRegistration: slots?.onRegistration ?? defaultOnRegistration,
    passwordPolicy: slots?.passwordPolicy ?? defaultPasswordPolicy,
    postLoginRedirect: slots?.postLoginRedirect ?? defaultPostLoginRedirect,
  }
}
