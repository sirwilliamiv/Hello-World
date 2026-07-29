import type { ConcurrencyLimitsSlot } from '@forge/ops-queue'

// Seeded by Forge from ops.queue@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when a worker leases work.
// Client-specific per-kind concurrency, usually to protect a rate-limited third party.

export const concurrencyLimits: ConcurrencyLimitsSlot = async (ctx) => {
  return ctx.proceed()
}
