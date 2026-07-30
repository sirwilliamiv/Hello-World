import { accessRuntime } from './runtime.js'

/** The two events declared in `publishes`, at contract version 1. */
export interface AccessEventPayloads {
  'access.role.granted': { user_id: string; role: string; scope?: string | null }
  'access.role.revoked': { user_id: string; role: string; scope?: string | null }
}

export type AccessEventName = keyof AccessEventPayloads

export const ACCESS_EVENT_CONTRACT_VERSIONS: Record<AccessEventName, number> = {
  'access.role.granted': 1,
  'access.role.revoked': 1,
}

export async function publishAccessEvent<E extends AccessEventName>(
  name: E,
  payload: AccessEventPayloads[E],
): Promise<void> {
  const runtime = await accessRuntime()
  await runtime.publish(name, payload as unknown as Record<string, unknown>)
}

/**
 * The envelope kernel.events hands a subscriber. Declared structurally and as
 * narrowly as possible so any superset kernel.events actually delivers
 * satisfies it.
 */
export interface IncomingEvent {
  name: string
  payload: unknown
}
