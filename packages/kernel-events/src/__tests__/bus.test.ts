/**
 * The three smoke tests named in the capability spec:
 *   - "publish and receive"          — a published event reaches every matching
 *                                      subscriber exactly once
 *   - "unregistered schema is rejected"
 *   - "handler failure dead-letters" — without blocking other subscribers
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { EventBus } from '../bus.js'
import { UnregisteredEventSchemaError, EventPayloadValidationError } from '../errors.js'
import { clearEventSchemas, listEventSchemas, registerEventSchema } from '../registry.js'
import { InMemoryEventStore } from '../store.js'

const paymentSucceeded = z.object({ chargeId: z.string(), amountMinor: z.number().int() })

const silentLogger = { warn: vi.fn(), error: vi.fn() }

function newBus(): { bus: EventBus; store: InMemoryEventStore } {
  const store = new InMemoryEventStore()
  let sequence = 0
  const bus = new EventBus({
    store,
    logger: silentLogger,
    now: () => new Date(0),
    newId: () => {
      sequence += 1
      return `id_${String(sequence)}`
    },
  })
  return { bus, store }
}

describe('event bus', () => {
  beforeEach(() => {
    clearEventSchemas()
    silentLogger.warn.mockClear()
    silentLogger.error.mockClear()
    registerEventSchema({
      name: 'payment.succeeded',
      contractVersion: 1,
      schema: paymentSucceeded,
      publisher: 'pay.card',
    })
    registerEventSchema({
      name: 'entity.created',
      contractVersion: 1,
      schema: z.object({ entity: z.string(), id: z.string() }),
      publisher: 'kernel.data',
    })
  })

  it('delivers a published event to every matching subscriber exactly once', async () => {
    const { bus } = newBus()
    const exact = vi.fn()
    const glob = vi.fn()
    const firehose = vi.fn()
    const unrelated = vi.fn()

    bus.subscribe('payment.succeeded', exact, { consumer: 'pay.invoices' })
    bus.subscribe('payment.*', glob, { consumer: 'ops.reporting' })
    bus.subscribe('**', firehose, { consumer: 'audit.history' })
    bus.subscribe('entity.created', unrelated, { consumer: 'data.search' })

    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 2500 })

    expect(exact).toHaveBeenCalledTimes(1)
    expect(glob).toHaveBeenCalledTimes(1)
    expect(firehose).toHaveBeenCalledTimes(1)
    expect(unrelated).not.toHaveBeenCalled()

    const envelope = exact.mock.calls[0]?.[0] as { name: string; payload: unknown; id: string }
    expect(envelope.name).toBe('payment.succeeded')
    expect(envelope.payload).toEqual({ chargeId: 'ch_1', amountMinor: 2500 })
  })

  it('appends every published event to the append-only log', async () => {
    const { bus, store } = newBus()
    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 100 })
    await bus.publish('payment.succeeded', { chargeId: 'ch_2', amountMinor: 200 })

    const logged = await store.list()
    expect(logged.map((e) => e.name)).toEqual(['payment.succeeded', 'payment.succeeded'])
    expect(logged.every((e) => e.contractVersion === 1)).toBe(true)
  })

  it('throws rather than silently dropping an event with no registered schema', async () => {
    const { bus, store } = newBus()
    const handler = vi.fn()
    bus.subscribe('**', handler)

    await expect(bus.publish('invoice.exploded', { anything: true })).rejects.toThrow(
      UnregisteredEventSchemaError,
    )
    // Nothing was logged and nothing was delivered.
    expect(await store.list()).toHaveLength(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it('throws when a payload does not satisfy its registered contract', async () => {
    const { bus } = newBus()
    await expect(
      bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 'lots' }),
    ).rejects.toThrow(EventPayloadValidationError)
  })

  it('dead-letters a failing handler without blocking other subscribers', async () => {
    const { bus, store } = newBus()
    const order: string[] = []

    bus.subscribe(
      'payment.succeeded',
      () => {
        order.push('first')
        throw new Error('downstream is down')
      },
      { consumer: 'pay.invoices' },
    )
    bus.subscribe(
      'payment.succeeded',
      () => {
        order.push('second')
      },
      { consumer: 'ops.reporting' },
    )
    bus.subscribe(
      '**',
      () => {
        order.push('third')
      },
      { consumer: 'audit.history' },
    )

    // The publisher is not made to fail by a broken consumer.
    await expect(
      bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 2500 }),
    ).resolves.toBeUndefined()

    expect(order).toEqual(['first', 'second', 'third'])

    const dead = await store.listDeadLetters()
    expect(dead).toHaveLength(1)
    expect(dead[0]?.consumer).toBe('pay.invoices')
    expect(dead[0]?.eventName).toBe('payment.succeeded')
    expect(dead[0]?.error).toBe('downstream is down')
    expect(dead[0]?.payload).toEqual({ chargeId: 'ch_1', amountMinor: 2500 })
  })

  it('retries up to maxAttempts before dead-lettering', async () => {
    const { bus, store } = newBus()
    let attempts = 0
    bus.subscribe(
      'payment.succeeded',
      () => {
        attempts += 1
        if (attempts < 3) throw new Error('transient')
      },
      { consumer: 'pay.invoices', maxAttempts: 3 },
    )

    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 1 })
    expect(attempts).toBe(3)
    expect(await store.listDeadLetters()).toHaveLength(0)
  })

  it('replays a dead letter to the current subscribers', async () => {
    const { bus, store } = newBus()
    const failing = bus.subscribe(
      'payment.succeeded',
      () => {
        throw new Error('down')
      },
      { consumer: 'pay.invoices' },
    )

    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 1 })
    const [dead] = await store.listDeadLetters()
    expect(dead).toBeDefined()

    // The consumer is fixed and redeployed: the old subscription goes away and a
    // working one takes its place.
    failing.unsubscribe()
    const fixed = vi.fn()
    bus.subscribe('payment.succeeded', fixed, { consumer: 'pay.invoices' })

    await expect(bus.replayDeadLetter(dead?.id ?? '')).resolves.toBe(true)
    expect(fixed).toHaveBeenCalledTimes(1)
    expect(await store.listDeadLetters()).toHaveLength(0)
  })

  it('skips a subscriber that does not handle the published contract version', async () => {
    const { bus } = newBus()
    registerEventSchema({
      name: 'payment.succeeded',
      contractVersion: 2,
      schema: paymentSucceeded,
      publisher: 'pay.card',
      deprecates: 1,
    })

    const v1Only = vi.fn()
    const anyVersion = vi.fn()
    bus.subscribe('payment.succeeded', v1Only, { contractVersions: [1] })
    bus.subscribe('payment.succeeded', anyVersion)

    // No explicit version: the latest registered contract wins.
    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 1 })
    expect(v1Only).not.toHaveBeenCalled()
    expect(anyVersion).toHaveBeenCalledTimes(1)

    await bus.publish(
      'payment.succeeded',
      { chargeId: 'ch_1', amountMinor: 1 },
      { contractVersion: 1 },
    )
    expect(v1Only).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes cleanly', async () => {
    const { bus } = newBus()
    const handler = vi.fn()
    const subscription = bus.subscribe('payment.succeeded', handler)
    subscription.unsubscribe()

    await bus.publish('payment.succeeded', { chargeId: 'ch_1', amountMinor: 1 })
    expect(handler).not.toHaveBeenCalled()
    expect(bus.listSubscriptions()).toHaveLength(0)
  })
})

describe('event schema registry', () => {
  beforeEach(() => {
    clearEventSchemas()
  })

  it('lists the catalog the webhook and automation surfaces derive from', () => {
    registerEventSchema({ name: 'b.happened', contractVersion: 1, schema: z.object({}) })
    registerEventSchema({ name: 'a.happened', contractVersion: 2, schema: z.object({}) })
    registerEventSchema({ name: 'a.happened', contractVersion: 1, schema: z.object({}) })

    expect(listEventSchemas().map((s) => `${s.name}@${String(s.contractVersion)}`)).toEqual([
      'a.happened@1',
      'a.happened@2',
      'b.happened@1',
    ])
  })

  it('refuses to redefine an existing contract version', () => {
    const schema = z.object({ a: z.string() })
    registerEventSchema({ name: 'a.happened', contractVersion: 1, schema })
    registerEventSchema({ name: 'a.happened', contractVersion: 1, schema }) // idempotent
    expect(() =>
      registerEventSchema({ name: 'a.happened', contractVersion: 1, schema: z.object({}) }),
    ).toThrow(/new contract_version/)
  })
})
