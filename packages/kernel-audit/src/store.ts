import type { AuditEntry, AuditStore } from './types.js'

/**
 * In-memory trail. Rejects any attempt to mutate an existing entry, so the
 * append-only guarantee is enforced by the store rather than by convention —
 * an audit trail that can be edited is not evidence of anything.
 */
export class InMemoryAuditStore implements AuditStore {
  readonly #entries: AuditEntry[] = []
  readonly #ids = new Set<string>()

  async append(entry: AuditEntry): Promise<void> {
    if (this.#ids.has(entry.id)) {
      throw new Error(`audit entry ${entry.id} already exists; entries are append-only`)
    }
    this.#ids.add(entry.id)
    this.#entries.push(Object.freeze({ ...entry }))
  }

  async list(filter: { entity?: string; entityId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    let out = this.#entries
    if (filter.entity !== undefined) out = out.filter((e) => e.entity === filter.entity)
    if (filter.entityId !== undefined) out = out.filter((e) => e.entityId === filter.entityId)
    // Newest first: a timeline is read from the most recent action backwards.
    const ordered = [...out].sort((a, b) => b.occurredAtSerial - a.occurredAtSerial)
    return filter.limit === undefined ? ordered : ordered.slice(0, filter.limit)
  }

  get size(): number {
    return this.#entries.length
  }
}
