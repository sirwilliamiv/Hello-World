import { publish } from '@forge/kernel-events'

/**
 * The six events `ops.queue` declares in `publishes`. Their contract version is
 * 1; the payload keys below are the ones in the specification, snake_case
 * because that is what the declared JSON schemas say.
 *
 * `kernel.events` types `publish` against the event union compiled from the
 * resolved graph, which a capability package cannot see at its own build time.
 * The cast is confined to this file so the uncertainty has one location.
 */
const emit = publish as unknown as (name: string, payload: unknown) => Promise<void>

export type QueueEventName =
  | 'job.enqueued'
  | 'job.started'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.dead_lettered'
  | 'queue.depth.exceeded'

export interface QueueEventPayloads {
  'job.enqueued': { job_id: string; kind: string; priority: number }
  'job.started': { job_id: string; kind: string; attempt: number }
  'job.succeeded': { job_id: string; kind: string; duration_ms: number }
  'job.failed': {
    job_id: string
    kind: string
    attempt: number
    error: string
    will_retry: boolean
  }
  'job.dead_lettered': { job_id: string; kind: string; attempts: number; error: string }
  'queue.depth.exceeded': { queue: string; depth: number; threshold: number }
}

/**
 * Telemetry must not be able to fail a job. A broken bus is reported loudly on
 * stderr and the work continues — losing the job because its `job.started`
 * event could not be published would be a worse failure than the one being
 * reported.
 */
export async function emitQueueEvent<E extends QueueEventName>(
  name: E,
  payload: QueueEventPayloads[E],
): Promise<void> {
  try {
    await emit(name, payload)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops.queue] could not publish ${name}: ${detail}`)
  }
}
