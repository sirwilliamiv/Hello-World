/**
 * `@forge/kernel-mail` — system email plumbing.
 *
 * Enough to deliver a verification message and a password reset, and nothing
 * else: no templating, no deliverability configuration, no tracking, no inbound
 * routing. `comms.email` upgrades this capability and adds all of it, so every
 * feature *not* here is a feature that upgrade does not have to fight.
 *
 * The exposed interface is one function, `send`, which `comms.email` must
 * satisfy to take over the slot.
 */

export { configureMail, mailConfig, maybeMailConfig, resetMail } from './config.js'
export type { MailConfigInput, ResolvedMailConfig } from './config.js'

export {
  DELIVER_JOB,
  deliverMessage,
  outboundMessages,
  registerMailJobs,
  send,
} from './mail.js'

export {
  resetMailDirectory,
  sendPasswordReset,
  sendVerification,
  setMailDirectory,
  type MailDirectory,
} from './handlers.js'

export { deleteMessages, exportMessages, type ExportedMessage } from './privacy.js'

export { MemoryOutboundMessageStore, type OutboundMessageStore } from './store.js'

export {
  ConsoleMailTransport,
  HttpMailTransport,
  MemoryMailTransport,
  transportForDsn,
} from './transports.js'

export {
  MailNotConfiguredError,
  MailTransportUnavailableError,
  type DeliverableMessage,
  type MailTransport,
  type OutboundMessage,
  type OutboundMessageInput,
  type OutboundMessageKind,
  type OutboundMessageStatus,
} from './types.js'
