/**
 * The bus.
 *
 * Delivery semantics, which are the whole contract:
 *
 *  1. An event with no registered schema throws. It is never silently dropped —
 *     a dropped event is a bug that surfaces as "the invoice was never created"
 *     three weeks later.
 *  2. A payload that does not satisfy its registered schema throws, before the
 *     event is logged and before any handler runs.
 *  3. Every matching subscription receives the event exactly once.
 *  4. A handler that throws does not affect any other handler. Its failure is
 *     dead-lettered with enough context to replay it.
 *
 * Fan-out is in-process and awaited: `publish` resolves once every handler has
 * settled. Durable, retried, out-of-process delivery is ops.queue's job, and a
 * capability that needs it enqueues from its handler rather than expecting the
 * bus to provide it.
 */

import { assertValidPattern, matchesPattern } from './pattern.js'
import { validatePayload } from './registry.js'
import { InMemoryEventStore, type EventStore } from './store.js'
import type {
  DeadLetterRecord,
  EventEnvelope,
  EventHandler,
  EventName,
  EventPattern,
  PayloadOf,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from './types.js'

export interface EventBusLogger {
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface EventBusOptions {
  store?: EventStore
  logger?: EventBusLogger
  /** Injectable clock. Tests and deterministic replays depend on it. */
  now?: () => Date
  /** Injectable id factory, for the same reason. */
  newId?: () => string
}

interface Registration {
  readonly id: string
  readonly pattern: EventPattern
  readonly handler: EventHandler<never>
  readonly consumer: string | undefined
  readonly contractVersions: readonly number[] | undefined
  readonly maxAttempts: number
}

const defaultLogger: EventBusLogger = {
  warn: (message, fields) => console.warn(message, fields ?? {}),
  error: (message, fields) => console.error(message, fields ?? {}),
}

export class EventBus {
  private registrations: Registration[] = []
  private store: EventStore
  private logger: EventBusLogger
  private now: () => Date
  private newId: () => string
  private counter = 0

  constructor(options: EventBusOptions = {}) {
    this.store = options.store ?? new InMemoryEventStore()
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
  }

  configure(options: EventBusOptions): void {
    if (options.store !== undefined) this.store = options.store
    if (options.logger !== undefined) this.logger = options.logger
    if (options.now !== undefined) this.now = options.now
    if (options.newId !== undefined) this.newId = options.newId
  }

  getStore(): EventStore {
    return this.store
  }

  /**
   * Subscribe a handler to a pattern.
   *
   * Called from the generated `src/generated/kernel.events/subscriptions.ts`,
   * which wires every `consumes` declaration in the resolved graph to its
   * handler. A subscription that is not declared in a capability specification
   * cannot appear there, which is how "nothing undeclared" is enforced at runtime.
   */
  subscribe<TPayload = unknown>(
    pattern: EventPattern,
    handler: EventHandler<TPayload>,
    options: SubscribeOptions = {},
  ): Subscription {
    assertValidPattern(pattern)

    this.counter += 1
    const id = `sub_${String(this.counter)}_${pattern}`
    const registration: Registration = {
      id,
      pattern,
      handler: handler as EventHandler<never>,
      consumer: options.consumer,
      contractVersions: options.contractVersions,
      maxAttempts: Math.max(1, options.maxAttempts ?? 1),
    }
    this.registrations.push(registration)

    return {
      id,
      pattern,
      consumer: options.consumer,
      unsubscribe: () => {
        this.registrations = this.registrations.filter((r) => r.id !== id)
      },
    }
  }

  /**
   * Publish an event. Throws before anything is delivered if the schema is not
   * registered or the payload does not satisfy it.
   */
  async publish<E extends EventName>(
    name: E,
    payload: PayloadOf<E>,
    options: PublishOptions = {},
  ): Promise<void> {
    const { registration, payload: validated } = validatePayload(
      name,
      payload,
      options.contractVersion,
    )

    const envelope: EventEnvelope = {
      id: this.newId(),
      name,
      contractVersion: registration.contractVersion,
      payload: validated,
      occurredAt: this.now(),
      ...(options.source === undefined ? {} : { source: options.source }),
      actor: options.actor ?? null,
      tenantId: options.tenantId ?? null,
      correlationId: options.correlationId ?? null,
      causationId: options.causationId ?? null,
    }

    // The log is written before delivery: an event that was published but whose
    // handlers all failed must still be replayable.
    await this.store.append(envelope)
    await this.deliver(envelope)
  }

  /** Deliver an already-logged envelope. Used by publish and by replay. */
  async deliver(envelope: EventEnvelope): Promise<void> {
    const matching = this.registrations.filter(
      (registration) =>
        matchesPattern(registration.pattern, envelope.name) &&
        (registration.contractVersions === undefined ||
          registration.contractVersions.includes(envelope.contractVersion)),
    )

    // allSettled, not all: one failing handler must never prevent another
    // subscriber from seeing the event.
    await Promise.allSettled(
      matching.map((registration) => this.invoke(registration, envelope)),
    )
  }

  private async invoke(registration: Registration, envelope: EventEnvelope): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= registration.maxAttempts; attempt += 1) {
      try {
        await registration.handler(envelope as EventEnvelope<never>)
        return
      } catch (error) {
        lastError = error
      }
    }

    const consumer = registration.consumer ?? registration.pattern
    const record: DeadLetterRecord = {
      id: this.newId(),
      eventId: envelope.id,
      eventName: envelope.name,
      contractVersion: envelope.contractVersion,
      consumer,
      subscriptionId: registration.id,
      payload: envelope.payload,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      stack: lastError instanceof Error ? lastError.stack : undefined,
      attempts: registration.maxAttempts,
      failedAt: this.now(),
      replayedAt: null,
    }

    this.logger.error(`event handler failed: ${envelope.name} -> ${consumer}`, {
      eventId: envelope.id,
      error: record.error,
    })

    try {
      await this.store.recordDeadLetter(record)
    } catch (storeError) {
      // The store failing is the one case where there is nowhere left to put the
      // failure. Log it loudly rather than throwing into the publisher, which
      // would turn one broken consumer into a broken publish.
      this.logger.error('failed to record dead letter', {
        eventId: envelope.id,
        error: storeError instanceof Error ? storeError.message : String(storeError),
      })
    }
  }

  /** Re-deliver a dead-lettered event to every current subscriber. */
  async replayDeadLetter(id: string): Promise<boolean> {
    const records = await this.store.listDeadLetters({ unreplayedOnly: false })
    const record = records.find((r) => r.id === id)
    if (record === undefined) return false

    const envelope = await this.store.get(record.eventId)
    if (envelope === undefined) return false

    await this.deliver(envelope)
    await this.store.markDeadLetterReplayed(id, this.now())
    return true
  }

  listDeadLetters(): Promise<DeadLetterRecord[]> {
    return this.store.listDeadLetters()
  }

  /** Every current subscription. Drives the admin "who is listening" view. */
  listSubscriptions(): Array<Pick<Subscription, 'id' | 'pattern' | 'consumer'>> {
    return this.registrations.map(({ id, pattern, consumer }) => ({ id, pattern, consumer }))
  }

  /** Test and hot-reload helper: drops every subscription. */
  reset(): void {
    this.registrations = []
    this.counter = 0
  }
}

/**
 * The product-wide bus. Generated code imports the free functions below, so the
 * common call site stays `import { publish, subscribe } from '@forge/kernel-events'`.
 */
export const eventBus = new EventBus()

export function configureEventBus(options: EventBusOptions): void {
  eventBus.configure(options)
}

export function publish<E extends EventName>(
  name: E,
  payload: PayloadOf<E>,
  options?: PublishOptions,
): Promise<void> {
  return eventBus.publish(name, payload, options)
}

export function subscribe<TPayload = unknown>(
  pattern: EventPattern,
  handler: EventHandler<TPayload>,
  options?: SubscribeOptions,
): Subscription {
  return eventBus.subscribe(pattern, handler, options)
}

export function listDeadLetters(): Promise<DeadLetterRecord[]> {
  return eventBus.listDeadLetters()
}

export function replayDeadLetter(id: string): Promise<boolean> {
  return eventBus.replayDeadLetter(id)
}

export function resetEventBus(): void {
  eventBus.reset()
}
