import { createElement, type ReactElement } from 'react'
import { deadLetters, queueDepth } from './queue.js'
import { queueRuntime } from './runtime.js'
import type { DeadLetterRow } from './types.js'

/**
 * The `QueueMonitor` ui_surface, mounted at `/admin/queues` behind the
 * `queue.read` permission.
 *
 * Kept deliberately plain: no design-token imports, no client-side state, no
 * data fetching inside the component. `kernel.ui` is not in this capability's
 * `requires`, so styling belongs to whatever mounts it — and a monitor that
 * renders from a snapshot is a monitor that can be tested without a database.
 */

export interface QueueMonitorSnapshot {
  readonly driver: string
  readonly depth: number
  readonly depthAlertThreshold: number
  readonly concurrency: number
  readonly maxAttempts: number
  readonly deadLettered: readonly DeadLetterRow[]
}

/** Read the numbers an operator needs. Server-side; call it, then render. */
export async function queueMonitorSnapshot(limit = 50): Promise<QueueMonitorSnapshot> {
  const { config } = queueRuntime()
  return {
    driver: config.driver,
    depth: await queueDepth(),
    depthAlertThreshold: config.depthAlertThreshold,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
    deadLettered: await deadLetters(limit),
  }
}

export interface QueueMonitorProps {
  readonly snapshot: QueueMonitorSnapshot
}

export function QueueMonitor({ snapshot }: QueueMonitorProps): ReactElement {
  const stat = (label: string, value: string | number): ReactElement =>
    createElement(
      'div',
      { key: label, 'data-queue-stat': label },
      createElement('dt', null, label),
      createElement('dd', null, String(value)),
    )

  return createElement(
    'section',
    { 'data-forge-surface': 'ops.queue:QueueMonitor' },
    createElement(
      'dl',
      null,
      stat('driver', snapshot.driver),
      stat('depth', snapshot.depth),
      stat('depth alert threshold', snapshot.depthAlertThreshold),
      stat('concurrency', snapshot.concurrency),
      stat('max attempts', snapshot.maxAttempts),
      stat('dead-lettered', snapshot.deadLettered.length),
    ),
    createElement(
      'ul',
      { 'data-queue-dead-letters': true },
      snapshot.deadLettered.map((entry) =>
        createElement(
          'li',
          { key: entry.id },
          `${entry.kind} — ${entry.attempts} attempts — ${entry.error}`,
        ),
      ),
    ),
  )
}
