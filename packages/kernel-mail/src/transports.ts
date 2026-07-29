import {
  MailTransportUnavailableError,
  type DeliverableMessage,
  type MailTransport,
} from './types.js'

/**
 * Transports, selected from the scheme of `MAIL_DSN`.
 *
 * `kernel.mail` is plumbing: it needs one way to hand a message to something
 * that sends it. Provider-specific behaviour — deliverability configuration,
 * bounce handling, suppression lists — is `comms.email`'s job, and putting any
 * of it here would make that upgrade a rewrite.
 */

/** Records instead of sending. The default when no DSN is configured. */
export class MemoryMailTransport implements MailTransport {
  readonly name = 'memory'
  readonly sent: DeliverableMessage[] = []

  async deliver(message: DeliverableMessage): Promise<void> {
    this.sent.push(message)
  }

  clear(): void {
    this.sent.length = 0
  }
}

/** Prints the envelope — never the body, which usually holds a live link. */
export class ConsoleMailTransport implements MailTransport {
  readonly name = 'console'

  async deliver(message: DeliverableMessage): Promise<void> {
    console.info(`[kernel.mail] ${message.from} -> ${message.to}: ${message.subject}`)
  }
}

/**
 * POSTs the message to a transactional provider's HTTP API. The DSN carries the
 * endpoint and, in its password field, the API key:
 * `https://api:KEY@api.provider.example/v1/send`.
 */
export class HttpMailTransport implements MailTransport {
  readonly name = 'http'

  constructor(private readonly dsn: URL) {}

  async deliver(message: DeliverableMessage): Promise<void> {
    const endpoint = new URL(this.dsn.toString())
    const token = decodeURIComponent(endpoint.password)
    endpoint.username = ''
    endpoint.password = ''

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
      }),
    })

    if (!response.ok) {
      // Thrown, not swallowed: the delivery job retries, and after the
      // ops.queue upgrade it retries durably.
      throw new Error(
        `mail provider rejected message ${message.id}: ${response.status} ${response.statusText}`,
      )
    }
  }
}

/**
 * Pick a transport for a DSN.
 *
 * `smtp:` is deliberately not implemented. A correct SMTP client — TLS
 * negotiation, AUTH, pipelining, retry classification — is a library, not a
 * hundred lines of kernel plumbing, and this capability has no dependencies to
 * spend on one. Configure an HTTPS provider endpoint, register a transport, or
 * take the `comms.email` upgrade.
 */
export function transportForDsn(dsn: string | undefined): MailTransport {
  if (dsn === undefined || dsn === '') return new MemoryMailTransport()

  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new MailTransportUnavailableError(dsn, 'MAIL_DSN is not a URL')
  }

  switch (url.protocol) {
    case 'memory:':
      return new MemoryMailTransport()
    case 'console:':
      return new ConsoleMailTransport()
    case 'http:':
    case 'https:':
      return new HttpMailTransport(url)
    case 'smtp:':
    case 'smtps:':
      throw new MailTransportUnavailableError(
        url.protocol,
        'kernel.mail 1.0.0 ships no SMTP client. Use an https:// provider endpoint, ' +
          'pass a transport to configureMail(), or take the comms.email upgrade.',
      )
    default:
      throw new MailTransportUnavailableError(
        url.protocol,
        'supported schemes are https, http, console and memory',
      )
  }
}
