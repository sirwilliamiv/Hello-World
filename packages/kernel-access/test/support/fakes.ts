import type { AccessRuntime, New, RepositoryApi, Where } from '../../src/runtime.js'

/**
 * In-memory stand-ins for kernel.data's `Repository<T>` and kernel.events'
 * `publish`/`subscribe`. One instance backs both this capability and
 * kernel.identity in these tests — the two runtimes are structurally identical,
 * and sharing the store is what lets a registration flow all the way through to
 * a role assignment.
 */

interface Row {
  id: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  [key: string]: unknown
}

class FakeRepository<T extends Row> implements RepositoryApi<T> {
  private readonly rows = new Map<string, T>()
  private sequence = 0

  constructor(
    private readonly entity: string,
    private readonly clock: () => Date,
  ) {}

  private matches(row: T, where: Where<T>): boolean {
    return Object.entries(where).every(([key, value]) => {
      const actual = (row as Record<string, unknown>)[key]
      if (value instanceof Date && actual instanceof Date) {
        return value.getTime() === actual.getTime()
      }
      return actual === value
    })
  }

  private visible(): T[] {
    return [...this.rows.values()].filter((row) => row.deletedAt === null)
  }

  async find(where: Where<T>): Promise<T | null> {
    return this.visible().find((row) => this.matches(row, where)) ?? null
  }

  async findMany(where: Where<T> = {}): Promise<T[]> {
    return this.visible().filter((row) => this.matches(row, where))
  }

  async create(values: New<T>): Promise<T> {
    this.sequence += 1
    const at = this.clock()
    const row = {
      ...(values as object),
      id: `${this.entity.toLowerCase()}_${this.sequence}`,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    } as T
    this.rows.set(row.id, row)
    return row
  }

  async update(id: string, values: Partial<New<T>>): Promise<T> {
    const existing = this.rows.get(id)
    if (existing === undefined) throw new Error(`${this.entity} ${id} not found`)
    const updated = { ...existing, ...(values as object), updatedAt: this.clock() } as T
    this.rows.set(id, updated)
    return updated
  }

  async softDelete(id: string): Promise<void> {
    const existing = this.rows.get(id)
    if (existing === undefined) return
    this.rows.set(id, { ...existing, deletedAt: this.clock() } as T)
  }

  async restore(id: string): Promise<void> {
    const existing = this.rows.get(id)
    if (existing === undefined) return
    this.rows.set(id, { ...existing, deletedAt: null } as T)
  }
}

export interface PublishedEvent {
  name: string
  payload: Record<string, unknown>
}

export type EventHandler = (event: { name: string; payload: unknown }) => Promise<void>

export interface TestRuntime extends AccessRuntime {
  events: PublishedEvent[]
  eventNames: () => string[]
  /** Stands in for kernel.events' `subscribe`, as the generated file wires it. */
  subscribe: (name: string, handler: EventHandler) => void
  advance: (ms: number) => void
}

export function createTestRuntime(startAt = new Date('2026-07-01T09:00:00.000Z')): TestRuntime {
  const repositories = new Map<string, FakeRepository<Row>>()
  const subscribers = new Map<string, EventHandler[]>()
  const events: PublishedEvent[] = []
  let clock = startAt

  const now = (): Date => new Date(clock.getTime())

  return {
    events,
    eventNames() {
      return events.map((event) => event.name)
    },
    advance(ms) {
      clock = new Date(clock.getTime() + ms)
    },
    subscribe(name, handler) {
      const existing = subscribers.get(name) ?? []
      existing.push(handler)
      subscribers.set(name, existing)
    },
    now,
    repository<T>(entity: string) {
      let repository = repositories.get(entity)
      if (repository === undefined) {
        repository = new FakeRepository<Row>(entity, now)
        repositories.set(entity, repository)
      }
      return repository as unknown as RepositoryApi<T>
    },
    async publish(name, payload) {
      events.push({ name, payload })
      for (const handler of subscribers.get(name) ?? []) {
        await handler({ name, payload })
      }
    },
  }
}
