import { record } from './audit.js'

/**
 * The trail is built by subscribing to the bus, not by every capability
 * remembering to call record(). That is why kernel.data's universal entity
 * events exist: audit, search, webhooks, and reporting all key off them rather
 * than coupling to individual capabilities.
 */
interface BusEvent {
  readonly name: string
  readonly payload: Record<string, unknown>
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key]
  return typeof v === 'string' ? v : null
}

export async function recordEntityEvent(event: BusEvent): Promise<void> {
  await record({
    action: event.name,
    actor: str(event.payload, 'actor'),
    entity: str(event.payload, 'entity'),
    entityId: str(event.payload, 'id'),
    summary: `${event.name} on ${str(event.payload, 'entity') ?? 'entity'}`,
  })
}

export async function recordIdentityEvent(event: BusEvent): Promise<void> {
  await record({
    action: event.name,
    actor: str(event.payload, 'user_id'),
    entity: 'User',
    entityId: str(event.payload, 'user_id'),
    summary: event.name,
  })
}

export async function recordAccessEvent(event: BusEvent): Promise<void> {
  await record({
    action: event.name,
    actor: str(event.payload, 'user_id'),
    entity: 'RoleAssignment',
    entityId: str(event.payload, 'user_id'),
    summary: `${event.name}: ${str(event.payload, 'role') ?? 'role'}`,
  })
}
