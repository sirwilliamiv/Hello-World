/**
 * `kernel.mail` is system email plumbing and nothing else: enough to deliver a
 * verification message and a password reset, and no more. No templating, no
 * deliverability configuration, no tracking, no inbound routing — those belong
 * to `comms.email`, which upgrades this capability. Anything added here that
 * `comms.email` would also have to provide makes that upgrade harder, so the
 * surface stays this small on purpose.
 */

/** What a caller hands to `send`. */
export interface OutboundMessageInput {
  readonly to: string
  readonly subject: string
  /** Plain text. There is no template engine here, deliberately. */
  readonly text: string
  /** Defaults to the configured `from`. */
  readonly from?: string | undefined
  readonly replyTo?: string | undefined
  /** Which system message this is, for the delivery record and metrics. */
  readonly kind?: OutboundMessageKind | undefined
  /** The user this message is about, so privacy export and deletion can find it. */
  readonly subjectUserId?: string | undefined
  /** A second send with the same key is the same message. */
  readonly idempotencyKey?: string | undefined
}

export type OutboundMessageKind = 'verification' | 'password_reset' | 'system'

export type OutboundMessageStatus = 'queued' | 'sent' | 'failed'

/**
 * The `OutboundMessage` entity this capability owns.
 *
 * The body is deliberately not retained beyond the send window: `text` is
 * cleared once the message is delivered. A verification link sitting in a
 * database table forever is a credential sitting in a database table forever.
 */
export interface OutboundMessage {
  readonly id: string
  readonly to: string
  readonly from: string
  readonly subject: string
  readonly kind: OutboundMessageKind
  readonly subjectUserId: string | null
  status: OutboundMessageStatus
  /** Cleared on delivery. */
  text: string | null
  readonly createdAt: Date
  sentAt: Date | null
  lastError: string | null
}

/** What a transport is given. The delivery record is not its business. */
export interface DeliverableMessage {
  readonly id: string
  readonly to: string
  readonly from: string
  readonly subject: string
  readonly text: string
  readonly replyTo: string | undefined
}

/**
 * How a message actually leaves the process. `comms.email` replaces the whole
 * capability rather than registering a transport here; this seam exists so a
 * product with an unusual provider is not forced into that upgrade, and so
 * tests do not need a mail server.
 */
export interface MailTransport {
  readonly name: string
  deliver(message: DeliverableMessage): Promise<void>
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'kernel.mail has not been configured. The generated ' +
        'src/generated/kernel.mail/config.ts calls configureMail() at boot with ' +
        'MAIL_DSN and MAIL_FROM_ADDRESS.',
    )
    this.name = 'MailNotConfiguredError'
  }
}

export class MailTransportUnavailableError extends Error {
  constructor(scheme: string, detail: string) {
    super(`no mail transport for ${JSON.stringify(scheme)}: ${detail}`)
    this.name = 'MailTransportUnavailableError'
  }
}
