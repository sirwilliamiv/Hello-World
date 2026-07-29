import { enqueue, registerJobHandler, type JobContext } from '@forge/kernel-work'
import { mailConfig } from './config.js'
import type { OutboundMessage, OutboundMessageInput } from './types.js'

/** The job kind delivery runs under. */
export const DELIVER_JOB = 'kernel.mail.deliver'

function newId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Hand a message to the outbound queue.
 *
 * Delivery is asynchronous because a request must never block on an SMTP round
 * trip — that is the stated reason `kernel.mail` requires `kernel.work`. It is
 * also why this capability gets durability for free: `enqueue` is
 * `kernel.work`'s, so in a product that took the `ops.queue` upgrade this same
 * call is a durable, retried, dead-lettered job with no change here.
 *
 * `comms.email` must satisfy this signature to upgrade this capability.
 */
export async function send(message: OutboundMessageInput): Promise<void> {
  const config = mailConfig()

  if (message.idempotencyKey !== undefined) {
    const existing = await config.store.findByIdempotencyKey(message.idempotencyKey)
    if (existing !== null) return
  }

  const record: OutboundMessage = {
    id: newId(),
    to: message.to,
    from: message.from ?? config.from,
    subject: message.subject,
    kind: message.kind ?? 'system',
    subjectUserId: message.subjectUserId ?? null,
    status: 'queued',
    text: message.text,
    createdAt: new Date(),
    sentAt: null,
    lastError: null,
  }
  await config.store.create(record, message.idempotencyKey ?? null)

  await enqueue({
    kind: DELIVER_JOB,
    payload: {
      messageId: record.id,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    },
    ...(message.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: `kernel.mail:${message.idempotencyKey}` }),
  })
}

/**
 * The delivery job.
 *
 * Errors are rethrown rather than recorded and swallowed: whether a failed
 * delivery is retried is the queue's decision, not this capability's, and
 * swallowing it here would take that decision away from the upgrade.
 */
export async function deliverMessage(ctx: JobContext): Promise<void> {
  const config = mailConfig()
  const messageId = ctx.payload['messageId']
  if (typeof messageId !== 'string') {
    throw new Error(`${DELIVER_JOB} job ${ctx.id} has no messageId in its payload`)
  }

  const message = await config.store.find(messageId)
  if (message === null) {
    throw new Error(`outbound message ${messageId} no longer exists`)
  }
  if (message.status === 'sent') return

  const replyTo = ctx.payload['replyTo']
  try {
    await config.transport.deliver({
      id: message.id,
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text ?? '',
      replyTo: typeof replyTo === 'string' ? replyTo : undefined,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await config.store.update(message.id, { status: 'failed', lastError: detail })
    throw error
  }

  await config.store.update(message.id, {
    status: 'sent',
    sentAt: new Date(),
    // The body is not retained beyond the send window.
    text: config.retainBody ? message.text : null,
    lastError: null,
  })
}

/** Delivery records. Read-only; the queue owns the retry decision. */
export async function outboundMessages(): Promise<OutboundMessage[]> {
  return mailConfig().store.list()
}

/**
 * Register the delivery job with `kernel.work`.
 *
 * Called by `configureMail` rather than run as an import side effect, so that
 * configuring mail twice — a second boot, a test — re-registers the handler
 * instead of leaving a queue with a job kind nothing answers.
 */
export function registerMailJobs(): void {
  registerJobHandler(DELIVER_JOB, deliverMessage)
}
