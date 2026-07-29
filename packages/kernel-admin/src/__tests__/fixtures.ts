/**
 * A stand-in for kernel.data's entity registry.
 *
 * The registry is another agent's package and is not implemented yet, so the
 * tests build one to the shape kernel.admin consumes (ports/entities.ts).
 * Nothing here is a mock of kernel.admin itself — every function under test is
 * the real one.
 *
 * The entity set is deliberately the Phase 1 mix: capability-owned entities
 * from the resolved kernel graph, plus manifest-declared client entities of the
 * shape §9.1 measured against ("12 client entities × 8 fields").
 */

import type { EntityDescriptor, EntitySource } from '../ports/entities.js'
import type {
  FindManyOptions,
  FindManyResult,
  Repository,
  Row,
} from '../ports/repository.js'

export const CAPABILITY_ENTITIES: readonly EntityDescriptor[] = [
  {
    name: 'User',
    owner: 'kernel.identity',
    personalData: true,
    tenantScoped: true,
    fields: [
      { name: 'email', type: 'email', required: true, unique: true },
      { name: 'name', type: 'string', required: true },
      { name: 'status', type: 'string', enum: ['invited', 'active', 'suspended'] },
      { name: 'lastSeenAt', type: 'datetime' },
    ],
  },
  {
    name: 'Invoice',
    owner: 'pay.invoices',
    tenantScoped: true,
    fields: [
      { name: 'number', type: 'string', required: true, unique: true },
      { name: 'customer', type: 'ref:User', required: true },
      { name: 'total', type: 'money', required: true },
      { name: 'status', type: 'string', enum: ['draft', 'sent', 'paid', 'void'] },
      { name: 'notes', type: 'text' },
      { name: 'metadata', type: 'json' },
      { name: 'issuedOn', type: 'date' },
      { name: 'paid', type: 'boolean' },
    ],
  },
  {
    name: 'AuditEntry',
    owner: 'kernel.audit',
    appendOnly: true,
    tenantScoped: true,
    fields: [
      { name: 'action', type: 'string', required: true },
      { name: 'actor', type: 'ref:User' },
      { name: 'payload', type: 'json' },
    ],
  },
]

/** Twelve manifest-declared entities, eight fields each. */
export const CLIENT_ENTITIES: readonly EntityDescriptor[] = Array.from(
  { length: 12 },
  (_unused, index): EntityDescriptor => ({
    name: `ClientThing${index + 1}`,
    owner: '<client>',
    tenantScoped: true,
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'reference', type: 'string', unique: true },
      { name: 'description', type: 'text' },
      { name: 'amount', type: 'money' },
      { name: 'count', type: 'integer' },
      { name: 'active', type: 'boolean' },
      { name: 'category', type: 'string', enum: ['alpha', 'beta', 'gamma'] },
      { name: 'occurredAt', type: 'datetime' },
    ],
  }),
)

/** One entity with the awkward shapes: refs, files, no obvious title field. */
export const AWKWARD_ENTITY: EntityDescriptor = {
  name: 'SiteVisit',
  owner: '<client>',
  plural: 'SiteVisits',
  tenantScoped: true,
  fields: [
    { name: 'customer', type: 'ref:User', required: true },
    { name: 'photos', type: 'refs:File' },
    { name: 'report', type: 'file' },
    { name: 'score', type: 'decimal' },
    { name: 'siteUrl', type: 'url' },
    { name: 'contactPhone', type: 'phone' },
  ],
}

export const ALL_ENTITIES: readonly EntityDescriptor[] = [
  ...CAPABILITY_ENTITIES,
  ...CLIENT_ENTITIES,
  AWKWARD_ENTITY,
]

export function entitySourceFor(
  descriptors: readonly EntityDescriptor[] = ALL_ENTITIES,
): EntitySource {
  const byName = new Map(descriptors.map((d) => [d.name, d]))
  return {
    get: (name) => byName.get(name),
    all: () => [...byName.values()],
  }
}

/** An in-memory Repository<T> good enough to drive the routes. */
export function memoryRepository(seed: readonly Row[] = []): Repository & {
  readonly rows: Row[]
} {
  const rows: Row[] = seed.map((row) => ({ ...row }))
  let nextId = rows.length + 1

  return {
    rows,
    async find(id: string): Promise<Row | undefined> {
      return rows.find((row) => String(row['id']) === id)
    },
    async findMany(options: FindManyOptions = {}): Promise<FindManyResult<Row>> {
      let matched = rows
      if (options.where !== undefined) {
        for (const [key, value] of Object.entries(options.where)) {
          matched = matched.filter((row) => String(row[key]) === String(value))
        }
      }
      if (options.search !== undefined && options.search !== '') {
        const needle = options.search.toLowerCase()
        matched = matched.filter((row) =>
          Object.values(row).some((v) => String(v).toLowerCase().includes(needle)),
        )
      }
      const total = matched.length
      const offset = options.offset ?? 0
      const limit = options.limit ?? total
      return { rows: matched.slice(offset, offset + limit), total }
    },
    async create(data: Partial<Row>): Promise<Row> {
      const row: Row = { id: String(nextId), ...data }
      nextId += 1
      rows.push(row)
      return row
    },
    async update(id: string, data: Partial<Row>): Promise<Row> {
      const row = rows.find((r) => String(r['id']) === id)
      if (row === undefined) throw new Error(`no row ${id}`)
      Object.assign(row, data)
      return row
    },
    async softDelete(id: string): Promise<void> {
      const row = rows.find((r) => String(r['id']) === id)
      if (row !== undefined) row['deletedAt'] = new Date().toISOString()
    },
    async restore(id: string): Promise<void> {
      const row = rows.find((r) => String(r['id']) === id)
      if (row !== undefined) delete row['deletedAt']
    },
  }
}
