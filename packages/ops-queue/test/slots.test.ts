import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@forge/kernel-events', () => ({
  publish: vi.fn(async () => {}),
  subscribe: vi.fn(),
}))

import { resetWorkBackend } from '@forge/kernel-work'
import {
  clearJobHandlers,
  configureQueue,
  createMemoryQueueStore,
  deadLetters,
  drainQueue,
  enqueue,
  findJob,
  registerJobHandler,
  shutdownQueue,
  type ConcurrencyLimitsSlot,
  type JobContext,
  type PriorityRulesSlot,
  type RetryPoliciesSlot,
} from '../src/index.js'

afterEach(async () => {
  await shutdownQueue()
  clearJobHandlers()
  resetWorkBackend()
})

describe('slots', () => {
  it('lets retryPolicies give up before max_attempts', async () => {
    const retryPolicies: RetryPoliciesSlot = (ctx) =>
      ctx.error.message.includes('permanent') ? { retry: false } : ctx.proceed()

    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      maxAttempts: 5,
      baseRetryDelayMs: 0,
      slots: { retryPolicies },
    })

    let runs = 0
    registerJobHandler('charge', () => {
      runs += 1
      throw new Error('card declined — permanent')
    })

    const ref = await enqueue({ kind: 'charge' })
    await drainQueue()

    // One attempt, not five: retrying a permanent failure is just latency.
    expect(runs).toBe(1)
    expect((await findJob(ref.id))?.status).toBe('dead_lettered')
    expect(await deadLetters()).toHaveLength(1)
  })

  it('lets retryPolicies set its own backoff', async () => {
    const delays: number[] = []
    const retryPolicies: RetryPoliciesSlot = (ctx) => {
      const decision = ctx.proceed()
      if (!decision.retry) return decision
      delays.push(ctx.attempt)
      return { retry: true, delayMs: 0 }
    }

    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      maxAttempts: 3,
      baseRetryDelayMs: 60_000,
      slots: { retryPolicies },
    })
    registerJobHandler('sync', () => {
      throw new Error('rate limited')
    })

    await enqueue({ kind: 'sync' })
    await drainQueue()

    expect(delays).toEqual([1, 2])
  })

  it('lets priorityRules reorder what the queue selects', async () => {
    const priorityRules: PriorityRulesSlot = (ctx) =>
      ctx.kind === 'urgent' ? 1000 : ctx.proceed()

    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      concurrency: 1,
      baseRetryDelayMs: 0,
      slots: { priorityRules },
    })

    const order: string[] = []
    const record = (ctx: JobContext): void => {
      order.push(ctx.kind)
    }
    registerJobHandler('routine', record)
    registerJobHandler('urgent', record)

    await enqueue({ kind: 'routine' })
    await enqueue({ kind: 'urgent' })
    await drainQueue()

    expect(order).toEqual(['urgent', 'routine'])
  })

  it('lets concurrencyLimits cap a rate-limited job kind', async () => {
    const concurrencyLimits: ConcurrencyLimitsSlot = (ctx) => ({
      ...ctx.proceed(),
      perKind: { 'provider.call': 1 },
    })

    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      concurrency: 10,
      baseRetryDelayMs: 0,
      slots: { concurrencyLimits },
    })

    let running = 0
    let peak = 0
    registerJobHandler('provider.call', async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
    })

    for (let i = 0; i < 4; i += 1) await enqueue({ kind: 'provider.call' })
    await drainQueue()

    expect(peak).toBe(1)
  })
})
