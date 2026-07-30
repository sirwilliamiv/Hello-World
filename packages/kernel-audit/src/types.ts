/** One recorded action. Append-only: corrections are new entries, never edits. */
export interface AuditEntry {
  readonly id: string
  readonly occurredAtSerial: number
  readonly actor: string | null
  readonly action: string
  readonly entity: string | null
  readonly entityId: string | null
  readonly summary: string
}

export interface AuditEntryInput {
  actor?: string | null
  action: string
  entity?: string | null
  entityId?: string | null
  summary?: string
}

/**
 * Storage for the trail. A port rather than a direct dependency so the policy
 * below — append-only, ordering, actor resolution — is testable without a
 * database, and so the Postgres adapter is the only thing that changes if the
 * data layer does.
 */
export interface AuditStore {
  append(entry: AuditEntry): Promise<void>
  list(filter?: { entity?: string; entityId?: string; limit?: number }): Promise<AuditEntry[]>
}
