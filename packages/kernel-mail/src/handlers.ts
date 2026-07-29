import { z } from 'zod'
import { mailConfig } from './config.js'
import { send } from './mail.js'

/**
 * The two event handlers named in `consumes`. The generated
 * `src/generated/kernel.events/subscriptions.ts` imports them by these exact
 * names and wires them to `identity.user.created` and
 * `identity.password.reset.requested`.
 *
 * Both take `unknown` and validate. That is not defensiveness for its own sake:
 * the bus is contract-versioned, a payload arriving here may have been
 * published by an older or newer producer than this package was built against,
 * and "the event did not have the shape I assumed" should be a named error at
 * the boundary rather than an undefined threaded into an email address.
 */

/**
 * A spec gap, handled rather than hidden.
 *
 * `identity.password.reset.requested` declares exactly one property — `user_id`.
 * `identity.user.created` declares `user_id` and `email`. Neither carries a
 * token or a link. So `kernel.mail` cannot, from the declared contracts alone,
 * address a reset message or put a working link in either message, and it may
 * not read `kernel.identity`'s tables — that capability is not in its
 * `requires`, and section 9.3 forbids it regardless.
 *
 * The resolution: `kernel.identity` supplies a directory at boot. Until it
 * does, the handlers use whatever undeclared-but-present fields the publisher
 * included, and fail with a message naming the missing piece rather than
 * sending a broken email. See the report note.
 */
export interface MailDirectory {
  /** The address for a user id. */
  address(userId: string): Promise<string | null>
  /** A single-use verification link. */
  verificationLink(userId: string): Promise<string | null>
  /** A single-use password reset link. */
  resetLink(userId: string): Promise<string | null>
}

const emptyDirectory: MailDirectory = {
  async address() {
    return null
  },
  async verificationLink() {
    return null
  },
  async resetLink() {
    return null
  },
}

let directory: MailDirectory = emptyDirectory

export function setMailDirectory(next: Partial<MailDirectory>): void {
  directory = { ...emptyDirectory, ...next }
}

export function resetMailDirectory(): void {
  directory = emptyDirectory
}

/** The event envelope, as either `{ name, payload }` or a bare payload. */
function payloadOf(event: unknown): Record<string, unknown> {
  if (typeof event !== 'object' || event === null) return {}
  const candidate = event as Record<string, unknown>
  const inner = candidate['payload']
  if (typeof inner === 'object' && inner !== null) return inner as Record<string, unknown>
  return candidate
}

const userCreated = z.object({
  user_id: z.string().min(1),
  email: z.string().email(),
  verification_url: z.string().optional(),
  token: z.string().optional(),
})

const passwordResetRequested = z.object({
  user_id: z.string().min(1),
  email: z.string().email().optional(),
  reset_url: z.string().optional(),
  token: z.string().optional(),
})

function link(base: string, path: string, token: string | undefined): string {
  const url = `${base}${path}`
  return token === undefined ? url : `${url}?token=${encodeURIComponent(token)}`
}

/** `identity.user.created` → the email verification message. */
export async function sendVerification(event: unknown): Promise<void> {
  const payload = userCreated.parse(payloadOf(event))
  const config = mailConfig()

  const url =
    payload.verification_url ??
    (await directory.verificationLink(payload.user_id)) ??
    (payload.token === undefined
      ? null
      : link(config.appUrl, '/auth/verify', payload.token))

  if (url === null) {
    throw new Error(
      `cannot send a verification message for user ${payload.user_id}: no verification ` +
        'link. Publish `verification_url` or `token` on identity.user.created, or ' +
        'register a directory with setMailDirectory().',
    )
  }

  await send({
    to: payload.email,
    subject: 'Confirm your email address',
    // No templating, by design. Two sentences and a link is the entire brief.
    text: `Confirm your email address to finish setting up your account:\n\n${url}\n`,
    kind: 'verification',
    subjectUserId: payload.user_id,
    // One message per user creation, however many times the event is delivered.
    idempotencyKey: `verification:${payload.user_id}`,
  })
}

/** `identity.password.reset.requested` → the password reset message. */
export async function sendPasswordReset(event: unknown): Promise<void> {
  const payload = passwordResetRequested.parse(payloadOf(event))
  const config = mailConfig()

  const to = payload.email ?? (await directory.address(payload.user_id))
  if (to === null) {
    throw new Error(
      `cannot send a password reset for user ${payload.user_id}: the ` +
        'identity.password.reset.requested contract carries no email address. ' +
        'Register a directory with setMailDirectory(), or publish `email` on the event.',
    )
  }

  const url =
    payload.reset_url ??
    (await directory.resetLink(payload.user_id)) ??
    (payload.token === undefined
      ? null
      : link(config.appUrl, '/auth/reset', payload.token))

  if (url === null) {
    throw new Error(
      `cannot send a password reset for user ${payload.user_id}: no reset link. ` +
        'Publish `reset_url` or `token` on identity.password.reset.requested, or ' +
        'register a directory with setMailDirectory().',
    )
  }

  await send({
    to,
    subject: 'Reset your password',
    text: `Use this link to choose a new password:\n\n${url}\n\nIf you did not ask for this, ignore this message.\n`,
    kind: 'password_reset',
    subjectUserId: payload.user_id,
  })
}
