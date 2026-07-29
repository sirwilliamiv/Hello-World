import { identityRuntime } from './runtime.js'

/**
 * The seven events declared in `publishes` in
 * catalog/kernel/kernel.identity.capability.json, with their contract-v1
 * payloads. Field names are snake_case because that is what the specification
 * declares and what consumers validate against.
 */
export interface IdentityEventPayloads {
  'identity.user.created': { user_id: string; email: string; source?: string }
  'identity.user.updated': { user_id: string; changed: string[] }
  'identity.user.deleted': { user_id: string; reason?: string }
  'identity.session.started': { user_id: string; session_id: string; ip?: string }
  'identity.session.ended': { user_id: string; session_id: string; reason?: string }
  'identity.login.failed': { email: string; ip?: string; reason?: string }
  'identity.password.reset.requested': { user_id: string }
}

export type IdentityEventName = keyof IdentityEventPayloads

export const IDENTITY_EVENT_CONTRACT_VERSIONS: Record<IdentityEventName, number> = {
  'identity.user.created': 1,
  'identity.user.updated': 1,
  'identity.user.deleted': 1,
  'identity.session.started': 1,
  'identity.session.ended': 1,
  'identity.login.failed': 1,
  'identity.password.reset.requested': 1,
}

/**
 * Publish one of this capability's declared events. Narrowed to the declared
 * set so an undeclared event cannot be emitted from here — the compile-time
 * half of kernel.events' "nothing undeclared" rule.
 */
export async function publishIdentityEvent<E extends IdentityEventName>(
  name: E,
  payload: IdentityEventPayloads[E],
): Promise<void> {
  const runtime = await identityRuntime()
  await runtime.publish(name, payload as unknown as Record<string, unknown>)
}
