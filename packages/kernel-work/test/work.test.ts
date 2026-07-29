import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@forge/kernel-events', () => ({
  publish: vi.fn(async () => {}),
  subscribe: vi.fn(),
}))

import {
  drainWork,
  enqueue,
  installWorkBackend,
  listJobs,
  registerJobHandler,
  resetWorkBackend,
  stopWork,
  type JobContext,
  type JobRef,
  type JobSpec,
} from '../src/index.js'

afterEach(async () => {
  await stopWork()
  resetWorkBackend()
})

describe('kernel.work — in-process background work', () => {
  it('runs enqueued work and makes its completion observable', async () => {
    const done: string[] = []
    registerJobHandler('greet', (ctx: JobContext) => {
      done.push(String(ctx.payload['name']))
    })

    const ref = await enqueue({ kind: 'greet', payload: { name: 'ada' } })
    await drainWork()

    expect(done).toEqual(['ada'])
    expect(listJobs().find((job) => job.id === ref.id)?.status).toBe('succeeded')
  })

  it('does not survive a restart — which is why ops.queue exists', async () => {
    registerJobHandler('greet', () => undefined)
    await enqueue({ kind: 'greet', runAt: new Date(Date.now() + 60_000) })
    expect(listJobs()).toHaveLength(1)

    // The process ends. Nothing was written anywhere, so nothing comes back.
    await stopWork()
    resetWorkBackend()

    expect(listJobs()).toHaveLength(0)
  })

  it('records a failure and does not retry it', async () => {
    let runs = 0
    registerJobHandler('flaky', () => {
      runs += 1
      throw new Error('boom')
    })

    const ref = await enqueue({ kind: 'flaky' })
    await drainWork()

    expect(runs).toBe(1)
    const job = listJobs().find((record) => record.id === ref.id)
    expect(job?.status).toBe('failed')
    expect(job?.lastError).toBe('boom')
  })

  it('fails a job whose kind has no handler, with a message naming the fix', async () => {
    const ref = await enqueue({ kind: 'nobody.registered.this' })
    await drainWork()
    expect(listJobs().find((job) => job.id === ref.id)?.lastError).toMatch(
      /registerJobHandler/,
    )
  })

  it('de-duplicates on an idempotency key', async () => {
    registerJobHandler('welcome', () => undefined)
    const first = await enqueue({ kind: 'welcome', idempotencyKey: 'user-1' })
    const second = await enqueue({ kind: 'welcome', idempotencyKey: 'user-1' })
    expect(second.id).toBe(first.id)
    expect(listJobs()).toHaveLength(1)
  })

  it('hands enqueue over to an installed backend, carrying registrations across', async () => {
    // The substitution seam ops.queue uses. Handlers registered before the
    // swap must reach the new backend, or import order would decide whether a
    // client's work runs.
    const seen: JobSpec[] = []
    registerJobHandler('early', () => undefined)

    const adopted: string[] = []
    installWorkBackend({
      name: 'test.backend',
      async enqueue(job: JobSpec): Promise<JobRef> {
        seen.push(job)
        return {
          id: 'test-job',
          kind: job.kind,
          queue: 'default',
          status: 'pending',
          attempts: 0,
          maxAttempts: 1,
          runAt: new Date(),
          enqueuedAt: new Date(),
        }
      },
      async schedule(_cron: string, job: JobSpec): Promise<JobRef> {
        return this.enqueue(job)
      },
      registerHandler(kind: string): void {
        adopted.push(kind)
      },
    })

    const ref = await enqueue({ kind: 'later' })
    expect(ref.id).toBe('test-job')
    expect(seen.map((job) => job.kind)).toEqual(['later'])
    expect(adopted).toEqual(['early'])
  })
})
