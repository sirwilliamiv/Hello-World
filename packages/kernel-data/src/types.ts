/**
 * The vocabulary of the data layer.
 */

/** PascalCase entity name, unique across the whole resolved graph. */
export type EntityName = string

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'uuid'
  | 'json'
  | 'money'
  | 'reference'

export interface FieldDefinition {
  readonly name: string
  /**
   * Declared field type. Accepts the manifest's type strings; anything the
   * registry does not recognise is stored and validated as opaque JSON.
   */
  readonly type: FieldType | string
  readonly required?: boolean
  readonly unique?: boolean
  readonly indexed?: boolean
  /** For type 'reference': the entity referred to. */
  readonly references?: EntityName
  readonly description?: string
}

/**
 * An entity registration. Written by generated code:
 *
 *   registerEntity({ name: 'Charge', owner: 'pay.card', tenantScoped: true, appendOnly: false, personalData: false })
 *
 * Capability entities and manifest-declared client entities land in the same
 * registry, which is why a client entity gets admin, audit, search and
 * reporting for free.
 */
export interface EntityRegistration {
  readonly name: EntityName
  /** Capability id that owns and is the sole writer of this entity, or '<client>'. */
  readonly owner: string
  /** Physical table name. Derived from `name` when omitted. */
  readonly table?: string
  readonly tenantScoped?: boolean
  readonly appendOnly?: boolean
  readonly personalData?: boolean
  readonly listable?: boolean
  readonly searchable?: boolean
  readonly fields?: readonly FieldDefinition[]
  readonly description?: string
}

/** A registration with every default resolved. What the repository reads. */
export interface EntityDefinition {
  readonly name: EntityName
  readonly owner: string
  readonly table: string
  readonly tenantScoped: boolean
  readonly appendOnly: boolean
  readonly personalData: boolean
  readonly listable: boolean
  readonly searchable: boolean
  readonly fields: readonly FieldDefinition[]
  readonly description: string | undefined
}

/**
 * The columns every entity carries. They are managed by the repository and are
 * never accepted from a caller: passing `revision` or `createdAt` to create() or
 * update() is ignored, because a client-supplied lock token is not a lock.
 */
export interface ManagedRow {
  readonly id: string
  /** Optimistic-locking counter. Incremented on every successful update. */
  readonly revision: number
  readonly createdAt: Date
  readonly updatedAt: Date
  /** Non-null once soft-deleted. */
  readonly deletedAt: Date | null
  /** Present on tenant-scoped entities once org.teams is in the graph. */
  readonly organizationId?: string | null
}

export type EntityRow = ManagedRow & Record<string, unknown>

/**
 * Who is writing, and on whose behalf.
 *
 * The tenant predicate is bound from here on every query. Nothing else in the
 * system is allowed to bind it — that is the whole point (ARCHITECTURE.md 14.2).
 */
export interface RepositoryContext {
  /** Tenant. Required for a tenant-scoped entity unless `allowUnscoped` is set. */
  readonly tenantId?: string | null
  /** The acting user id. Carried into every entity.* event as `actor`. */
  readonly actor?: string | null
  /** Groups every event produced by one logical operation. */
  readonly correlationId?: string | null
  /**
   * Deliberate cross-tenant access, for migrations, backfills and platform
   * admin surfaces. Only ever set through `systemContext()`, so a grep for it
   * finds every place tenant scoping was stepped around.
   */
  readonly allowUnscoped?: boolean
}

/** The context for a migration, backfill or platform-admin operation. */
export function systemContext(actor = 'system'): RepositoryContext {
  return { actor, allowUnscoped: true }
}

export interface FindOptions {
  /** Include soft-deleted rows. Default false. */
  readonly includeDeleted?: boolean
}

export interface FindManyOptions extends FindOptions {
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: readonly OrderBy[]
}

export interface OrderBy {
  readonly column: string
  readonly direction?: 'asc' | 'desc'
}

/** Fields a caller may supply. The managed columns are not among them. */
export type WritableValues = Record<string, unknown>
