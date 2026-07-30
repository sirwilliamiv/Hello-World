import { mailConfig } from './config.js'
import type { OutboundMessage } from './types.js'

/**
 * The privacy handlers `OutboundMessage` declares:
 * `export_handler: exportMessages`, `deletion_strategy: delete`,
 * `deletion_handler: deleteMessages`.
 *
 * Validation check 10 requires them whenever `data.privacy` is enabled, so they
 * exist under those exact names.
 */

export interface ExportedMessage {
  readonly id: string
  readonly to: string
  readonly from: string
  readonly subject: string
  readonly kind: string
  readonly status: string
  readonly created_at: string
  readonly sent_at: string | null
}

function exportable(message: OutboundMessage): ExportedMessage {
  return {
    id: message.id,
    to: message.to,
    from: message.from,
    subject: message.subject,
    kind: message.kind,
    status: message.status,
    created_at: message.createdAt.toISOString(),
    sent_at: message.sentAt === null ? null : message.sentAt.toISOString(),
  }
}

/**
 * Everything this capability holds about a data subject. The body is absent
 * because it is not retained past delivery — an export cannot return what was
 * deliberately not kept.
 */
export async function exportMessages(userId: string): Promise<ExportedMessage[]> {
  const messages = await mailConfig().store.listBySubject(userId)
  return messages.map(exportable)
}

/** Hard delete, matching the declared `deletion_strategy: delete`. */
export async function deleteMessages(userId: string): Promise<number> {
  return mailConfig().store.deleteBySubject(userId)
}
