import { z } from 'zod'
import { MemoryOutboundMessageStore, type OutboundMessageStore } from './store.js'
import { transportForDsn } from './transports.js'
import { MailNotConfiguredError, type MailTransport } from './types.js'

/**
 * What `src/generated/kernel.mail/config.ts` passes: `dsn` and `from`, read
 * from the environment at boot. Forge generates the schema for those names and
 * never their values (ARCHITECTURE.md section 9.4), which is why `from` is
 * optional here — `MAIL_FROM_ADDRESS` is declared optional in the capability's
 * `external.credentials`.
 */
export interface MailConfigInput {
  readonly dsn?: string | undefined
  readonly from?: string | undefined
  /** Base URL for the links in verification and reset messages. */
  readonly appUrl?: string | undefined
  readonly transport?: MailTransport | undefined
  readonly store?: OutboundMessageStore | undefined
  /**
   * Keep the message body after delivery. Off by default: a verification link
   * retained forever is a live credential retained forever.
   */
  readonly retainBody?: boolean | undefined
}

export interface ResolvedMailConfig {
  readonly dsn: string | undefined
  readonly from: string
  readonly appUrl: string
  readonly transport: MailTransport
  readonly store: OutboundMessageStore
  readonly retainBody: boolean
}

const schema = z.object({
  dsn: z.string().min(1).optional(),
  from: z.string().email().default('no-reply@localhost'),
  appUrl: z.string().url().optional(),
  retainBody: z.boolean().default(false),
})

let config: ResolvedMailConfig | undefined

export function configureMail(input: MailConfigInput = {}): ResolvedMailConfig {
  const parsed = schema.parse({
    dsn: input.dsn,
    from: input.from,
    appUrl: input.appUrl ?? process.env['APP_URL'],
    retainBody: input.retainBody,
  })

  config = {
    dsn: parsed.dsn,
    from: parsed.from,
    // Relative links still work when the app is served from its own origin.
    appUrl: (parsed.appUrl ?? '').replace(/\/+$/, ''),
    transport: input.transport ?? transportForDsn(parsed.dsn),
    store: input.store ?? new MemoryOutboundMessageStore(),
    retainBody: parsed.retainBody,
  }
  return config
}

export function mailConfig(): ResolvedMailConfig {
  if (config === undefined) throw new MailNotConfiguredError()
  return config
}

export function maybeMailConfig(): ResolvedMailConfig | undefined {
  return config
}

/** Test seam. */
export function resetMail(): void {
  config = undefined
}
