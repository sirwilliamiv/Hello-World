import type { OnRegistrationSlot } from '@forge/kernel-identity'

// Seeded by Forge from kernel.identity@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called after a user record is created, before the welcome email.
// Client-specific onboarding: default records, external enrolment, invite-code redemption.

export const onRegistration: OnRegistrationSlot = async (ctx) => {
  return ctx.proceed()
}
