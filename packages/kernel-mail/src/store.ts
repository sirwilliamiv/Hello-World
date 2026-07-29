import type { OutboundMessage } from './types.js'

/**
 * Where delivery records live.
 *
 * `kernel.mail` declares `requires: [kernel.work]` and nothing else — notably
 * not `kernel.data` — so this capability has no sanctioned repository to write
 * through, and reaching for one anyway would be exactly the cross-capability
 * coupling ARCHITECTURE.md section 9.3 forbids. The port is therefore explicit,
 * the default is in-process, and a product that wants durable delivery records
 * injects a store. See the report note: `kernel.data` almost certainly belongs
 * in this capability's `requires`.
 */
export interface OutboundMessageStore {
  create(message: OutboundMessage, idempotencyKey: string | null): Promise<OutboundMessage>
  find(id: string): Promise<OutboundMessage | null>
  findByIdempotencyKey(key: string): Promise<OutboundMessage | null>
  update(id: string, changes: Partial<OutboundMessage>): Promise<void>
  /** Privacy export: every message about a data subject. */
  listBySubject(userId: string): Promise<OutboundMessage[]>
  /** Privacy deletion: the declared strategy is `delete`, not anonymise. */
  deleteBySubject(userId: string): Promise<number>
  list(): Promise<OutboundMessage[]>
}

export class MemoryOutboundMessageStore implements OutboundMessageStore {
  private readonly messages = new Map<string, OutboundMessage>()
  private readonly byIdempotencyKey = new Map<string, string>()

  async create(message: OutboundMessage, idempotencyKey: string | null): Promise<OutboundMessage> {
    this.messages.set(message.id, message)
    if (idempotencyKey !== null) this.byIdempotencyKey.set(idempotencyKey, message.id)
    return message
  }

  async find(id: string): Promise<OutboundMessage | null> {
    return this.messages.get(id) ?? null
  }

  async findByIdempotencyKey(key: string): Promise<OutboundMessage | null> {
    const id = this.byIdempotencyKey.get(key)
    return id === undefined ? null : (this.messages.get(id) ?? null)
  }

  async update(id: string, changes: Partial<OutboundMessage>): Promise<void> {
    const message = this.messages.get(id)
    if (message === undefined) return
    Object.assign(message, changes)
  }

  async listBySubject(userId: string): Promise<OutboundMessage[]> {
    return [...this.messages.values()].filter((message) => message.subjectUserId === userId)
  }

  async deleteBySubject(userId: string): Promise<number> {
    const doomed = await this.listBySubject(userId)
    for (const message of doomed) this.messages.delete(message.id)
    return doomed.length
  }

  async list(): Promise<OutboundMessage[]> {
    return [...this.messages.values()]
  }
}
