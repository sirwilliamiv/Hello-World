/**
 * The event vocabulary.
 *
 * `EventPayloadMap` is deliberately empty here and is filled in by declaration
 * merging from the generated `src/generated/kernel.events/event-types.ts`, which
 * is compiled from the resolved graph's `publishes` schemas. That is what makes
 * `publish('payment.succeeded', payload)` a *build* error when the payload does
 * not match the declared contract, rather than a runtime surprise:
 *
 *     declare module '@forge/kernel-events' {
 *       interface EventPayloadMap {
 *         'payment.succeeded': { chargeId: string; amountMinor: number }
 *       }
 *     }
 *
 * Until a product's generated types are loaded the map is empty, and event names
 * fall back to `string` so the package still compiles standalone.
 */

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface EventPayloadMap {}

/** Event names known to the compiler, from the generated event types. */
export type KnownEventName = Extract<keyof EventPayloadMap, string>

/**
 * The name of a publishable event. Narrows to the resolved graph's event set
 * once the generated types are in scope; `string` before that.
 */
export type EventName = [KnownEventName] extends [never] ? string : KnownEventName

/** The payload type declared for an event, or `unknown` when it is not known. */
export type PayloadOf<E extends string> = E extends keyof EventPayloadMap
  ? EventPayloadMap[E]
  : unknown

/**
 * A subscription pattern: an exact event name, a segment glob such as
 * `entity.*`, or `**` for every event in the system (audit.history,
 * automation.rules and integrate.webhooks all subscribe with `**`).
 */
export type EventPattern = string

/**
 * A published event as it is persisted and as a handler receives it.
 *
 * Append-only: replay and audit both depend on the log being immutable.
 */
export interface EventEnvelope<TPayload = unknown> {
  /** Stable identifier. Also the idempotency key for a consumer. */
  readonly id: string
  /** Event name, e.g. 'entity.created' or 'payment.succeeded'. */
  readonly name: string
  /** The contract version this payload was produced against. */
  readonly contractVersion: number
  /** Validated against the registered schema before this envelope existed. */
  readonly payload: TPayload
  /** When the event happened. */
  readonly occurredAt: Date
  /** Capability id of the publisher, when it declared one. */
  readonly source?: string
  /** The acting user, when the event happened in a request context. */
  readonly actor?: string | null
  /** Tenant the event belongs to, when the product is tenant-scoped. */
  readonly tenantId?: string | null
  /** Groups every event produced by one logical operation. */
  readonly correlationId?: string | null
  /** The event that caused this one, for tracing a chain of reactions. */
  readonly causationId?: string | null
}

/** Alias matching the name used in the capability specification's signatures. */
export type { EventEnvelope as Event }

// The return value is deliberately unconstrained: the bus never consumes it.
// Typing it as void forces every handler that happens to return something --
// docs.generation's renderInvoice returns the document it produced -- to be
// wrapped at the subscription site, which the generated wiring cannot do.
export type EventHandler<TPayload = unknown> = (
  event: EventEnvelope<TPayload>,
) => unknown

export interface SubscribeOptions {
  /** Identifies the subscriber in dead letters and logs, e.g. 'pay.invoices'. */
  readonly consumer?: string
  /** Contract versions this handler understands. Others are skipped, not failed. */
  readonly contractVersions?: readonly number[]
  /** Attempts before the event is dead-lettered. Default 1 — no retry. */
  readonly maxAttempts?: number
}

export interface Subscription {
  readonly id: string
  readonly pattern: EventPattern
  readonly consumer: string | undefined
  /** Removes the subscription. Returned for tests and for hot-reload teardown. */
  unsubscribe(): void
}

export interface PublishOptions {
  readonly contractVersion?: number
  readonly source?: string
  readonly actor?: string | null
  readonly tenantId?: string | null
  readonly correlationId?: string | null
  readonly causationId?: string | null
}

/** A handler failure, retained for inspection and replay. */
export interface DeadLetterRecord {
  readonly id: string
  readonly eventId: string
  readonly eventName: string
  readonly contractVersion: number
  readonly consumer: string
  readonly subscriptionId: string
  readonly payload: unknown
  readonly error: string
  readonly stack?: string | undefined
  readonly attempts: number
  readonly failedAt: Date
  readonly replayedAt?: Date | null
}
