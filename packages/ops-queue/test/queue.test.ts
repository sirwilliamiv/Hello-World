import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bus is another capability's package. Mocking it keeps these tests about
// the queue's behaviour, and lets them assert exactly which lifecycle events
// were published — `job.dead_lettered` firing exactly once is a spec property.
vi.mock('@forge/kernel-events', () => ({
  publish: vi.fn(async () => {}),
  subscribe: vi.fn(),
}))

import { publish } from '@forge/kernel-events'
import {
  enqueue as kernelWorkEnqueue,
  resetWorkBackend,
  schedule as kernelWorkSchedule,
} from '@forge/kernel-work'
import {
  MemoryQueueStore,
  clearJobHandlers,
  configureQueue,
  createMemoryQueueStore,
  deadLetters,
  drainQueue,
  enqueue,
  findJob,
  jobAttempts,
  queueDepth,
  registerJobHandler,
  replay,
  shutdownQueue,
  type JobContext,
} from '../src/index.js'

function publishedEventNames(): string[] {
  return vi.mocked(publish).mock.calls.map((call) => String(call[0]))
}

function published<T>(name: string): T[] {
  return vi
    .mocked(publish)
    .mock.calls.filter((call) => call[0] === name)
    .map((call) => call[1] as T)
}

beforeEach(() => {
  vi.mocked(publish).mockClear()
})

afterEach(async () => {
  await shutdownQueue()
  clearJobHandlers()
  resetWorkBackend()
})

describe('ops.queue — durable background processing', () => {
  it('runs work that was enqueued before the process restarted', async () => {
    // The smoke property: "a job enqueued before a process restart still runs
    // after it — the property kernel.work does not have."
    const store = createMemoryQueueStore()
    configureQueue({ driver: 'memory', store, baseRetryDelayMs: 0 })

    const ref = await enqueue({ kind: 'greet', payload: { name: 'ada' } })
    expect(await queueDepth()).toBe(1)

    // Everything the process would have left on disk, and nothing else.
    const onDisk = JSON.parse(JSON.stringify(store.serialise())) as never

    await shutdownQueue()
    clearJobHandlers()
    resetWorkBackend()

    // A new process, with no memory of the old one.
    const greeted: string[] = []
    configureQueue({
      driver: 'memory',
      store: MemoryQueueStore.fromSnapshot(onDisk),
      baseRetryDelayMs: 0,
    })
    registerJobHandler('greet', (ctx: JobContext) => {
      greeted.push(String(ctx.payload['name']))
    })

    await drainQueue()

    expect(greeted).toEqual(['ada'])
    expect((await findJob(ref.id))?.status).toBe('succeeded')
  })

  it('retries to max_attempts and then dead-letters exactly once', async () => {
    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      maxAttempts: 3,
      baseRetryDelayMs: 0,
    })

    let runs = 0
    registerJobHandler('flaky', () => {
      runs += 1
      throw new Error('third-party said no')
    })

    const ref = await enqueue({ kind: 'flaky', payload: { invoice: 'inv_1' } })
    await drainQueue()

    expect(runs).toBe(3)
    expect((await findJob(ref.id))?.status).toBe('dead_lettered')

    // The attempt history is append-only, so every failure is still visible.
    const attempts = await jobAttempts(ref.id)
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3])
    expect(attempts.every((attempt) => attempt.outcome === 'failed')).toBe(true)

    // Exactly once, in the table and on the bus.
    expect((await deadLetters()).filter((entry) => entry.jobId === ref.id)).toHaveLength(1)
    expect(published('job.dead_lettered')).toHaveLength(1)

    const failures = published<{ will_retry: boolean }>('job.failed')
    expect(failures.map((event) => event.will_retry)).toEqual([true, true, false])
  })

  it('replays a dead-lettered job with its original payload intact', async () => {
    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      maxAttempts: 2,
      baseRetryDelayMs: 0,
    })

    const payload = { invoice: 'inv_7', lines: [1, 2, 3], meta: { retryable: true } }
    let received: unknown
    registerJobHandler('render', () => {
      throw new Error('renderer unavailable')
    })

    const ref = await enqueue({ kind: 'render', payload })
    await drainQueue()
    expect((await findJob(ref.id))?.status).toBe('dead_lettered')

    // The renderer is back.
    registerJobHandler('render', (ctx: JobContext) => {
      received = ctx.payload
    })

    const replayed = await replay(ref)
    expect(replayed.id).not.toBe(ref.id)
    await drainQueue()

    expect(received).toEqual(payload)
    expect((await findJob(replayed.id))?.status).toBe('succeeded')

    const entry = (await deadLetters()).find((row) => row.jobId === ref.id)
    expect(entry?.replayJobId).toBe(replayed.id)
    expect(entry?.payload).toEqual(payload)
  })

  it('leases a job to one worker only', async () => {
    const store = createMemoryQueueStore()
    configureQueue({ driver: 'memory', store })
    const ref = await enqueue({ kind: 'once' })

    const first = await store.lease({
      queues: ['default'],
      limit: 10,
      workerId: 'a',
      now: new Date(),
      excludeKinds: [],
    })
    const second = await store.lease({
      queues: ['default'],
      limit: 10,
      workerId: 'b',
      now: new Date(),
      excludeKinds: [],
    })

    expect(first.map((row) => row.id)).toEqual([ref.id])
    expect(second).toEqual([])
    expect(first[0]?.attempts).toBe(1)
  })

  it('returns work whose worker died to the pending pool', async () => {
    const store = createMemoryQueueStore()
    configureQueue({ driver: 'memory', store, visibilityTimeoutMs: 1000 })
    const ref = await enqueue({ kind: 'orphan' })

    await store.lease({
      queues: ['default'],
      limit: 1,
      workerId: 'doomed',
      now: new Date(),
      excludeKinds: [],
    })
    expect((await findJob(ref.id))?.status).toBe('running')

    // The worker holding it never came back; its lease has now aged out.
    const reclaimed = await store.reclaimExpiredLeases(new Date(Date.now() + 60_000))
    expect(reclaimed).toBe(1)
    expect((await findJob(ref.id))?.status).toBe('pending')
  })

  it('de-duplicates on an idempotency key', async () => {
    configureQueue({ driver: 'memory', store: createMemoryQueueStore() })
    const first = await enqueue({ kind: 'welcome', idempotencyKey: 'user-1' })
    const second = await enqueue({ kind: 'welcome', idempotencyKey: 'user-1' })
    expect(second.id).toBe(first.id)
    expect(await queueDepth()).toBe(1)
  })

  it('publishes the declared lifecycle events for a job that succeeds', async () => {
    configureQueue({ driver: 'memory', store: createMemoryQueueStore(), baseRetryDelayMs: 0 })
    registerJobHandler('ok', () => undefined)
    await enqueue({ kind: 'ok' })
    await drainQueue()

    expect(publishedEventNames()).toEqual(
      expect.arrayContaining(['job.enqueued', 'job.started', 'job.succeeded']),
    )
  })

  it('alerts once when the queue depth crosses the threshold', async () => {
    configureQueue({
      driver: 'memory',
      store: createMemoryQueueStore(),
      depthAlertThreshold: 2,
    })
    for (let i = 0; i < 5; i += 1) await enqueue({ kind: 'backlog' })

    const alerts = published<{ depth: number; threshold: number }>('queue.depth.exceeded')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.threshold).toBe(2)
  })

  it('refuses a driver it cannot honour rather than losing work quietly', () => {
    expect(() => configureQueue({ driver: 'redis', url: 'redis://localhost:6379' })).toThrow(
      /not implemented/,
    )
  })
})

describe('the upgrade takes over kernel.work’s slot', () => {
  it('routes @forge/kernel-work enqueue through the durable queue', async () => {
    // This is the substitution in ARCHITECTURE.md section 3, from the point of
    // view of a capability package: kernel.mail imports enqueue from
    // @forge/kernel-work and never learns that ops.queue answered.
    const store = createMemoryQueueStore()
    configureQueue({ driver: 'memory', store, baseRetryDelayMs: 0 })

    const done: string[] = []
    registerJobHandler('mail.deliver', (ctx: JobContext) => {
      done.push(String(ctx.payload['to']))
    })

    const ref = await kernelWorkEnqueue({
      kind: 'mail.deliver',
      payload: { to: 'ada@example.com' },
    })

    // Durable before it ran: the row exists in the store, not in a timer.
    expect(await store.findJob(ref.id)).not.toBeNull()

    await drainQueue()
    expect(done).toEqual(['ada@example.com'])
  })

  it('routes @forge/kernel-work schedule through the durable schedule table', async () => {
    const store = createMemoryQueueStore()
    configureQueue({ driver: 'memory', store })

    const ref = await kernelWorkSchedule('0 3 * * *', { kind: 'nightly.report' })

    expect(ref.status).toBe('scheduled')
    expect(await store.dueSchedules(new Date(Date.now() + 86_400_000))).toHaveLength(1)
  })

  it('re-registers handlers that were declared before the queue was configured', async () => {
    // Import order between the generated config and a capability's module-level
    // registration must not matter.
    const { registerJobHandler: registerViaKernelWork } = await import('@forge/kernel-work')
    const ran: string[] = []
    registerViaKernelWork('early', () => {
      ran.push('early')
    })

    configureQueue({ driver: 'memory', store: createMemoryQueueStore(), baseRetryDelayMs: 0 })
    await enqueue({ kind: 'early' })
    await drainQueue()

    expect(ran).toEqual(['early'])
  })
})
