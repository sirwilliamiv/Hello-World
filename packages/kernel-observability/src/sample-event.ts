/**
 * The `sampleEvent` handler named in the spec's `consumes` block:
 *
 *   { "name": "**", "contract_versions": [1], "required": false,
 *     "reason": "sample every event in the system for tracing and metrics",
 *     "handler": "sampleEvent" }
 *
 * The generated `src/generated/kernel.events/subscriptions.ts` imports this by
 * name and passes it to `subscribe`, so the exported identifier and its arity
 * are load-bearing.
 *
 * kernel.observability declares `requires: []`, so this file cannot import
 * `@forge/kernel-events` for its `Event` type. The parameter is typed
 * structurally against the shape the event bus documents instead — a handler
 * that only reads `name` and metadata is compatible with any envelope that
 * carries them.
 */

import { logger } from './logger.js'
import { increment } from './metrics.js'
import { redact } from './redact.js'

/** The subset of the kernel.events envelope this handler reads. */
export interface SampledEvent {
  readonly name: string
  readonly contractVersion?: number
  readonly id?: string
  readonly payload?: unknown
}

export interface SamplingOptions {
  /** 0..1. Payloads are logged for this fraction of events. Default 0. */
  readonly payloadSampleRate?: number
}

let payloadSampleRate = 0

export function configureSampling(options: SamplingOptions): void {
  if (options.payloadSampleRate !== undefined) {
    payloadSampleRate = Math.min(1, Math.max(0, options.payloadSampleRate))
  }
}

/**
 * Count every event and, at the configured sample rate, record its payload.
 *
 * Counting is unconditional because an event-rate metric is what tells us a
 * publisher has gone quiet. Payloads are off by default because an event
 * payload is the most likely place for personal data to reach a log.
 */
export async function sampleEvent(event: SampledEvent): Promise<void> {
  increment('forge_events_total', {
    event: event.name,
    version: event.contractVersion ?? 0,
  })

  if (payloadSampleRate > 0 && Math.random() < payloadSampleRate) {
    logger.debug('event sampled', {
      event: event.name,
      version: event.contractVersion ?? 0,
      id: event.id ?? '',
      payload: redact(event.payload),
    })
  }
}
