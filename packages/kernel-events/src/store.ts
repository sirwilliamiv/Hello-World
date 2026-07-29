/**
 * Where the bus keeps the event log, the resolved subscriptions and the dead
 * letters.
 *
 * The port is small on purpose: the bus holds the delivery semantics, and the
 * store holds nothing but persistence, so the semantics are identical whether a
 * product is running against Postgres or a test is running in memory.
 */

import type { DeadLetterRecord, EventEnvelope } from './types.js'

export interface EventQuery {
  readonly name?: string
  readonly since?: Date
  readonly limit?: number
}

export interface DeadLetterQuery {
  readonly eventName?: string
  readonly consumer?: string
  /** Default true — replayed dead letters are excluded unless asked for. */
  readonly unreplayedOnly?: boolean
  readonly limit?: number
}

export interface EventStore {
  /** Append-only. An event log that can be rewritten cannot be replayed or audited. */
  append(event: EventEnvelope): Promise<void>
  list(query?: EventQuery): Promise<EventEnvelope[]>
  get(id: string): Promise<EventEnvelope | undefined>

  recordDeadLetter(record: DeadLetterRecord): Promise<void>
  listDeadLetters(query?: DeadLetterQuery): Promise<DeadLetterRecord[]>
  markDeadLetterReplayed(id: string, replayedAt: Date): Promise<void>
}

/**
 * The default store. Keeps everything in process, which is the right behaviour
 * for tests and for a product that has not configured a database yet; a real
 * product calls `configureEventBus({ store: new DrizzleEventStore(db) })` at boot.
 */
export class InMemoryEventStore implements EventStore {
  private readonly events: EventEnvelope[] = []
  private readonly deadLetters: DeadLetterRecord[] = []

  append(event: EventEnvelope): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }

  list(query: EventQuery = {}): Promise<EventEnvelope[]> {
    let rows = this.events
    if (query.name !== undefined) rows = rows.filter((e) => e.name === query.name)
    if (query.since !== undefined) {
      const since = query.since
      rows = rows.filter((e) => e.occurredAt >= since)
    }
    return Promise.resolve(query.limit === undefined ? [...rows] : rows.slice(0, query.limit))
  }

  get(id: string): Promise<EventEnvelope | undefined> {
    return Promise.resolve(this.events.find((e) => e.id === id))
  }

  recordDeadLetter(record: DeadLetterRecord): Promise<void> {
    this.deadLetters.push(record)
    return Promise.resolve()
  }

  listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterRecord[]> {
    let rows = this.deadLetters
    if (query.eventName !== undefined) rows = rows.filter((d) => d.eventName === query.eventName)
    if (query.consumer !== undefined) rows = rows.filter((d) => d.consumer === query.consumer)
    if (query.unreplayedOnly !== false) rows = rows.filter((d) => d.replayedAt == null)
    return Promise.resolve(query.limit === undefined ? [...rows] : rows.slice(0, query.limit))
  }

  markDeadLetterReplayed(id: string, replayedAt: Date): Promise<void> {
    const index = this.deadLetters.findIndex((d) => d.id === id)
    const existing = this.deadLetters[index]
    if (existing !== undefined) {
      this.deadLetters[index] = { ...existing, replayedAt }
    }
    return Promise.resolve()
  }

  /** Test helper. */
  reset(): void {
    this.events.length = 0
    this.deadLetters.length = 0
  }
}
