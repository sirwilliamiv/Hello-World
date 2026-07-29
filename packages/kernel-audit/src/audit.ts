import type { AuditEntry, AuditEntryInput, AuditStore } from './types.js'
import { InMemoryAuditStore } from './store.js'

let store: AuditStore = new InMemoryAuditStore()
let serial = 0

/** Installs the backing store. The Postgres adapter calls this at boot. */
export function installAuditStore(next: AuditStore): void {
  store = next
}

export function resetAudit(): void {
  store = new InMemoryAuditStore()
  serial = 0
}

/**
 * Records one action.
 *
 * `audit.history` upgrades this capability and must satisfy this signature, so
 * every caller keeps working unchanged when a client buys the richer trail.
 */
export async function record(input: AuditEntryInput): Promise<void> {
  serial += 1
  const entry: AuditEntry = {
    // Derived from the serial rather than random, so a replayed sequence
    // produces identical ids and a test can assert on them.
    id: `audit-${String(serial).padStart(12, '0')}`,
    occurredAtSerial: serial,
    actor: input.actor ?? null,
    action: input.action,
    entity: input.entity ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary ?? input.action,
  }
  await store.append(entry)
}

export function auditTrail(filter?: { entity?: string; entityId?: string; limit?: number }) {
  return store.list(filter)
}
