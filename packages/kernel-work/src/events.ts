import { publish } from '@forge/kernel-events'
import { workOptions } from './config.js'

/**
 * `kernel.events` types `publish` against the event union compiled from the
 * resolved graph, which a capability package cannot see at its own build time.
 * The cast is confined to this one function so the uncertainty has exactly one
 * location; the event names and payload shapes below are the ones declared in
 * the capability specification.
 */
const emit = publish as unknown as (name: string, payload: unknown) => Promise<void>

export type WorkLifecycleEvent = 'job.enqueued' | 'job.started' | 'job.succeeded' | 'job.failed'

export async function emitJobEvent(
  name: WorkLifecycleEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!workOptions().publishLifecycle) return
  await emit(name, payload)
}
