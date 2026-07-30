/**
 * Repository<T> — the only sanctioned data access path.
 *
 * Everything that must be true of every write in the system is true because it
 * is enforced here, not because a capability author remembered:
 *
 *   - **Tenant scoping.** A tenant-scoped entity cannot be read or written
 *     without a tenant in context. The predicate is bound by the repository, so
 *     a capability cannot issue an unscoped query without bypassing it — and
 *     bypassing it is a CI failure (ARCHITECTURE.md 9.3, 14.2).
 *   - **Append-only.** An append-only entity refuses update and delete outright.
 *     Corrections are new rows.
 *   - **Soft delete.** `softDelete` sets `deleted_at`; every read excludes
 *     deleted rows unless they are asked for.
 *   - **Timestamps.** `created_at` and `updated_at` are managed here and are
 *     never accepted from a caller.
 *   - **Optimistic locking.** Every update carries the revision it was read at
 *     and is applied with `where revision = <expected>`. A concurrent write
 *     therefore updates zero rows and fails, rather than silently overwriting.
 *   - **Lifecycle events.** entity.created / updated / deleted / restored are
 *     published for every entity, which is what audit, search, webhooks,
 *     automation and reporting subscribe to.
 *   - **Slots.** beforePersist, customValidator and afterPersist run at the
 *     points the capability spec declares.
 */

import { getDriver, newId, now } from './db.js'
import type { DataDriver, Predicate, RowValues, SelectOptions } from './driver.js'
import {
  AppendOnlyViolationError,
  EntityNotFoundError,
  StaleWriteError,
  TenantScopeError,
  ValidationFailedError,
  WriteRejectedError,
} from './errors.js'
import { changedFields, emitEntityEvent } from './events.js'
import { getEntity } from './registry.js'
import {
  beforePersistControls,
  getSlots,
  type AfterPersistContext,
  type TransactionalRepository,
} from './slots.js'
import type {
  EntityDefinition,
  EntityName,
  EntityRow,
  FindManyOptions,
  FindOptions,
  RepositoryContext,
  WritableValues,
} from './types.js'
import { validateValues } from './validate.js'

/** Columns the repository owns. A caller may never set them directly. */
const MANAGED_COLUMNS = ['revision', 'createdAt', 'updatedAt', 'deletedAt', 'organizationId']

export interface EntityRepository<T extends EntityRow = EntityRow> {
  readonly entity: EntityDefinition
  readonly context: RepositoryContext

  find(id: string, options?: FindOptions): Promise<T | null>
  findOrFail(id: string, options?: FindOptions): Promise<T>
  findOne(where: Readonly<WritableValues>, options?: FindOptions): Promise<T | null>
  findMany(where?: Readonly<WritableValues>, options?: FindManyOptions): Promise<T[]>
  count(where?: Readonly<WritableValues>, options?: FindOptions): Promise<number>

  create(values: WritableValues): Promise<T>
  /** `expectedRevision` is the revision the row was read at. Required — a write
   *  without it is a last-write-wins write, which is the bug this prevents. */
  update(id: string, patch: WritableValues, expectedRevision: number): Promise<T>
  softDelete(id: string, expectedRevision?: number): Promise<T>
  restore(id: string, expectedRevision?: number): Promise<T>
  /** Irreversible. Refused for append-only entities, like every other delete. */
  purge(id: string): Promise<void>

  withContext(context: RepositoryContext): EntityRepository<T>
}

class Repo<T extends EntityRow = EntityRow> implements EntityRepository<T> {
  readonly entity: EntityDefinition

  constructor(
    entityName: EntityName,
    readonly context: RepositoryContext = {},
    private readonly driverOverride?: DataDriver,
  ) {
    this.entity = getEntity(entityName)
  }

  withContext(context: RepositoryContext): EntityRepository<T> {
    return new Repo<T>(this.entity.name, { ...this.context, ...context }, this.driverOverride)
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async find(id: string, options: FindOptions = {}): Promise<T | null> {
    const rows = await this.driver.select(this.entity.table, this.predicate({ id }, options), {
      limit: 1,
    })
    const row = rows[0]
    return row === undefined ? null : (row as unknown as T)
  }

  async findOrFail(id: string, options: FindOptions = {}): Promise<T> {
    const row = await this.find(id, options)
    if (row === null) throw new EntityNotFoundError(this.entity.name, id)
    return row
  }

  async findOne(where: Readonly<WritableValues>, options: FindOptions = {}): Promise<T | null> {
    const rows = await this.findMany(where, { ...options, limit: 1 })
    return rows[0] ?? null
  }

  async findMany(
    where: Readonly<WritableValues> = {},
    options: FindManyOptions = {},
  ): Promise<T[]> {
    const select: SelectOptions = {
      orderBy: options.orderBy ?? [{ column: 'createdAt', direction: 'asc' }],
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.offset === undefined ? {} : { offset: options.offset }),
    }
    const rows = await this.driver.select(this.entity.table, this.predicate(where, options), select)
    return rows as unknown as T[]
  }

  count(where: Readonly<WritableValues> = {}, options: FindOptions = {}): Promise<number> {
    return this.driver.count(this.entity.table, this.predicate(where, options))
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async create(values: WritableValues): Promise<T> {
    this.assertTenantInContext()

    const input = stripManaged(values)
    const validated = await this.runValidation(input, 'create', undefined)
    const persisted = await this.runBeforePersist(validated, 'create', undefined)

    const timestamp = now()
    const row: RowValues = {
      id: typeof persisted['id'] === 'string' ? persisted['id'] : newId(),
      ...persisted,
      ...(this.entity.tenantScoped && this.context.tenantId != null
        ? { organizationId: this.context.tenantId }
        : {}),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }

    const written = await this.driver.transaction(async (tx) => {
      const inserted = await tx.insert(this.entity.table, row)
      await this.runAfterPersist(tx, 'create', inserted, undefined)
      return inserted
    })

    await emitEntityEvent(
      'entity.created',
      {
        entity: this.entity.name,
        id: String(written['id']),
        actor: this.context.actor ?? null,
        data: serialisable(written),
      },
      this.context,
    )

    return written as unknown as T
  }

  async update(id: string, patch: WritableValues, expectedRevision: number): Promise<T> {
    this.assertMutable('update')
    this.assertTenantInContext()

    const existing = await this.findOrFail(id)
    if (existing.revision !== expectedRevision) {
      throw new StaleWriteError(this.entity.name, id, expectedRevision, existing.revision)
    }

    const input = stripManaged(patch)
    const validated = await this.runValidation(input, 'update', existing)
    const persisted = await this.runBeforePersist(validated, 'update', existing)

    const written = await this.driver.transaction(async (tx) => {
      // The revision predicate is the lock. Two writers that both read revision
      // 3 both issue `where revision = 3`; the second updates no rows and fails
      // here rather than quietly discarding the first writer's change.
      const rows = await tx.update(
        this.entity.table,
        this.predicate({ id, revision: expectedRevision }, {}),
        { ...persisted, revision: expectedRevision + 1, updatedAt: now() },
      )
      const updated = rows[0]
      if (updated === undefined) {
        throw new StaleWriteError(this.entity.name, id, expectedRevision)
      }
      await this.runAfterPersist(tx, 'update', updated, existing)
      return updated
    })

    const before = serialisable(existing)
    const after = serialisable(written)
    await emitEntityEvent(
      'entity.updated',
      {
        entity: this.entity.name,
        id,
        actor: this.context.actor ?? null,
        before,
        after,
        changed: changedFields(before, after).filter((field) => field !== 'updatedAt'),
      },
      this.context,
    )

    return written as unknown as T
  }

  async softDelete(id: string, expectedRevision?: number): Promise<T> {
    this.assertMutable('delete')
    this.assertTenantInContext()

    const existing = await this.findOrFail(id)
    const revision = expectedRevision ?? existing.revision
    if (existing.revision !== revision) {
      throw new StaleWriteError(this.entity.name, id, revision, existing.revision)
    }

    const written = await this.driver.transaction(async (tx) => {
      const rows = await tx.update(
        this.entity.table,
        this.predicate({ id, revision }, {}),
        { deletedAt: now(), updatedAt: now(), revision: revision + 1 },
      )
      const updated = rows[0]
      if (updated === undefined) throw new StaleWriteError(this.entity.name, id, revision)
      await this.runAfterPersist(tx, 'softDelete', updated, existing)
      return updated
    })

    await emitEntityEvent(
      'entity.deleted',
      { entity: this.entity.name, id, actor: this.context.actor ?? null, soft: true },
      this.context,
    )

    return written as unknown as T
  }

  async restore(id: string, expectedRevision?: number): Promise<T> {
    this.assertMutable('restore')
    this.assertTenantInContext()

    const existing = await this.findOrFail(id, { includeDeleted: true })
    const revision = expectedRevision ?? existing.revision
    if (existing.revision !== revision) {
      throw new StaleWriteError(this.entity.name, id, revision, existing.revision)
    }

    const written = await this.driver.transaction(async (tx) => {
      const rows = await tx.update(
        this.entity.table,
        this.predicate({ id, revision }, { includeDeleted: true }),
        { deletedAt: null, updatedAt: now(), revision: revision + 1 },
      )
      const updated = rows[0]
      if (updated === undefined) throw new StaleWriteError(this.entity.name, id, revision)
      await this.runAfterPersist(tx, 'restore', updated, existing)
      return updated
    })

    await emitEntityEvent(
      'entity.restored',
      { entity: this.entity.name, id, actor: this.context.actor ?? null },
      this.context,
    )

    return written as unknown as T
  }

  async purge(id: string): Promise<void> {
    this.assertMutable('purge')
    this.assertTenantInContext()

    const removed = await this.driver.delete(
      this.entity.table,
      this.predicate({ id }, { includeDeleted: true }),
    )
    if (removed === 0) throw new EntityNotFoundError(this.entity.name, id)

    await emitEntityEvent(
      'entity.deleted',
      { entity: this.entity.name, id, actor: this.context.actor ?? null, soft: false },
      this.context,
    )
  }

  // ── enforcement ──────────────────────────────────────────────────────────

  private get driver(): DataDriver {
    return this.driverOverride ?? getDriver()
  }

  private assertMutable(operation: string): void {
    if (this.entity.appendOnly) {
      throw new AppendOnlyViolationError(this.entity.name, operation)
    }
  }

  private assertTenantInContext(): void {
    if (!this.entity.tenantScoped) return
    if (this.context.allowUnscoped === true) return
    if (this.context.tenantId == null || this.context.tenantId === '') {
      throw new TenantScopeError(this.entity.name)
    }
  }

  /** Every query the repository issues goes through here. */
  private predicate(where: Readonly<WritableValues>, options: FindOptions): Predicate {
    this.assertTenantInContext()

    const equals: RowValues = { ...where }
    if (this.entity.tenantScoped && this.context.allowUnscoped !== true) {
      equals['organizationId'] = this.context.tenantId ?? null
    }

    const predicate: Predicate = {
      equals,
      ...(options.includeDeleted === true ? {} : { isNull: ['deletedAt'] }),
    }
    return predicate
  }

  private async runValidation(
    values: WritableValues,
    operation: 'create' | 'update',
    existing: EntityRow | undefined,
  ): Promise<WritableValues> {
    const outcome = validateValues(this.entity, values, operation)
    const issues = [...outcome.issues]

    const validator = getSlots().customValidator
    if (validator !== undefined) {
      const custom = await validator({
        entity: this.entity,
        operation,
        data: outcome.values,
        existing,
        context: this.context,
      })
      for (const issue of custom) {
        issues.push(issue.field === undefined ? issue.message : `${issue.field}: ${issue.message}`)
      }
    }

    if (issues.length > 0) throw new ValidationFailedError(this.entity.name, issues)
    return outcome.values
  }

  private async runBeforePersist(
    values: WritableValues,
    operation: 'create' | 'update',
    existing: EntityRow | undefined,
  ): Promise<WritableValues> {
    const slot = getSlots().beforePersist
    if (slot === undefined) return values

    const result = await slot({
      entity: this.entity,
      operation,
      data: values,
      existing,
      context: this.context,
      ...beforePersistControls(),
    })

    if (result.action === 'reject') {
      throw new WriteRejectedError(this.entity.name, result.reason ?? 'no reason given')
    }
    return stripManaged(result.data ?? values)
  }

  private async runAfterPersist(
    tx: DataDriver,
    operation: AfterPersistContext['operation'],
    row: RowValues,
    previous: EntityRow | undefined,
  ): Promise<void> {
    const slot = getSlots().afterPersist
    if (slot === undefined) return

    await slot({
      entity: this.entity,
      operation,
      row: row as EntityRow,
      previous,
      context: this.context,
      repository: (entity: string): TransactionalRepository =>
        new Repo(entity, this.context, tx) as TransactionalRepository,
    })
  }
}

/**
 * Open a repository for an entity.
 *
 *     const invoices = Repository<Invoice>('Invoice', { tenantId, actor })
 *     const invoice = await invoices.findOrFail(id)
 *     await invoices.update(id, { status: 'paid' }, invoice.revision)
 */
export function Repository<T extends EntityRow = EntityRow>(
  entity: EntityName,
  context: RepositoryContext = {},
): EntityRepository<T> {
  return new Repo<T>(entity, context)
}

/** Strip the columns the repository manages; a caller never sets them. */
function stripManaged(values: WritableValues): WritableValues {
  const copy: WritableValues = {}
  for (const [key, value] of Object.entries(values)) {
    if (MANAGED_COLUMNS.includes(key)) continue
    copy[key] = value
  }
  return copy
}

/** A row as it goes into an event payload: JSON-shaped, dates as ISO strings. */
function serialisable(row: Readonly<RowValues>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value
  }
  return out
}
