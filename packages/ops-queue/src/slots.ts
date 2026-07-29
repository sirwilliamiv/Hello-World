/**
 * Slot types for `ops.queue`.
 *
 * ARCHITECTURE.md section 4: the slot's *type* lives in the npm package and
 * upgrades with it, so a changed signature breaks the client's build loudly and
 * locally. Each context carries `proceed()`, returning what the queue would
 * have done, so the seeded stub is a one-liner and a client only writes the
 * part it actually wants to change.
 */

import type { JobPayload } from './types.js'

/* -------------------------------------------------------------- retryPolicies */

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  /** Give up now. The job dead-letters, whatever the attempt count says. */
  | { readonly retry: false }

export interface RetryPolicyContext {
  readonly jobId: string
  readonly kind: string
  readonly queue: string
  readonly payload: JobPayload
  /** The attempt that just failed. 1 on the first failure. */
  readonly attempt: number
  readonly maxAttempts: number
  readonly error: Error
  /** Exponential backoff until `maxAttempts`, then give up. */
  proceed(): RetryDecision
}

/** Called when a failed job's next attempt is scheduled. */
export type RetryPoliciesSlot = (
  ctx: RetryPolicyContext,
) => RetryDecision | Promise<RetryDecision>

/* --------------------------------------------------------- concurrencyLimits */

export interface ConcurrencyLimits {
  /** Total jobs this worker may run at once. */
  readonly global: number
  /** Per-kind ceilings, usually to protect a rate-limited third party. */
  readonly perKind: Readonly<Record<string, number>>
}

export interface ConcurrencyContext {
  readonly queue: string
  /** The `concurrency` value from the manifest. */
  readonly configured: number
  /** How many jobs of each kind this worker is running right now. */
  readonly running: Readonly<Record<string, number>>
  /** `{ global: configured, perKind: {} }`. */
  proceed(): ConcurrencyLimits
}

/** Called when a worker leases work. */
export type ConcurrencyLimitsSlot = (
  ctx: ConcurrencyContext,
) => ConcurrencyLimits | Promise<ConcurrencyLimits>

/* ------------------------------------------------------------- priorityRules */

export interface PriorityContext {
  readonly kind: string
  readonly queue: string
  readonly payload: JobPayload
  /** What the caller asked for, if anything. */
  readonly requested: number | undefined
  /** `requested ?? DEFAULT_PRIORITY`. Higher runs first. */
  proceed(): number
}

/**
 * Called when a job enters the queue, and again when a leased batch is ordered,
 * so a client's rule holds whether the queue is empty or backed up.
 */
export type PriorityRulesSlot = (ctx: PriorityContext) => number | Promise<number>

/** Alias for call sites that name the slot after the concern rather than the rules. */
export type PrioritySlot = PriorityRulesSlot

/* ---------------------------------------------------------------------------- */

/**
 * What `src/slots/ops.queue/` exports. Every slot is optional: an unimplemented
 * slot is the default behaviour, not a hole.
 */
export interface QueueSlots {
  readonly retryPolicies?: RetryPoliciesSlot | undefined
  readonly concurrencyLimits?: ConcurrencyLimitsSlot | undefined
  readonly priorityRules?: PriorityRulesSlot | undefined
}
