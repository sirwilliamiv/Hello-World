import type { RetryPoliciesSlot } from '@forge/ops-queue'

// Seeded by Forge from ops.queue@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when a failed job's next attempt is scheduled.
// Client-specific backoff and give-up rules per job kind.

export const retryPolicies: RetryPoliciesSlot = async (ctx) => {
  return ctx.proceed()
}
