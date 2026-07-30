/**
 * The kernel.data slots.
 *
 * Slots are the sanctioned place for client-specific logic and the pressure
 * valve that keeps the managed zone from being hand-edited. Forge seeds a stub
 * once, into `src/slots/kernel.data/<name>.ts`, and never touches it again:
 *
 *     import type { BeforePersistSlot } from '@forge/kernel-data'
 *
 *     export const beforePersist: BeforePersistSlot = async (ctx) => ctx.proceed()
 *
 * The *type* lives here, in the package, so it upgrades with the package. A major
 * version that changes one of these signatures makes the client's slot fail to
 * compile — loud, local and fixable, which is exactly the outcome we want.
 */

import type {
  EntityDefinition,
  EntityRow,
  RepositoryContext,
  WritableValues,
} from './types.js'

export type PersistOperation = 'create' | 'update'

export interface BeforePersistResult {
  readonly action: 'proceed' | 'reject'
  readonly data?: WritableValues
  readonly reason?: string
}

export interface BeforePersistContext {
  readonly entity: EntityDefinition
  readonly operation: PersistOperation
  /** The validated values about to be written. */
  readonly data: Readonly<WritableValues>
  /** The current row, on an update. Undefined on a create. */
  readonly existing: Readonly<EntityRow> | undefined
  readonly context: RepositoryContext
  /** Continue, optionally replacing the values to be written. */
  proceed(data?: WritableValues): BeforePersistResult
  /** Refuse the write. The repository throws WriteRejectedError. */
  reject(reason: string): BeforePersistResult
}

/** Client-specific mutation or rejection of a write, after validation. */
export type BeforePersistSlot = (
  ctx: BeforePersistContext,
) => Promise<BeforePersistResult> | BeforePersistResult

export interface AfterPersistContext {
  readonly entity: EntityDefinition
  readonly operation: PersistOperation | 'softDelete' | 'restore'
  /** The row as written. */
  readonly row: Readonly<EntityRow>
  readonly previous: Readonly<EntityRow> | undefined
  readonly context: RepositoryContext
  /**
   * A repository bound to the same transaction as the write that triggered this
   * slot. Side effects performed through it commit or roll back with the write;
   * anything done outside it does not.
   */
  repository(entity: string): TransactionalRepository
}

/** Client-specific side effects that must be transactional with the write. */
export type AfterPersistSlot = (ctx: AfterPersistContext) => Promise<void> | void

export interface ValidationIssue {
  readonly field?: string
  readonly message: string
}

export interface CustomValidatorContext {
  readonly entity: EntityDefinition
  readonly operation: PersistOperation
  readonly data: Readonly<WritableValues>
  readonly existing: Readonly<EntityRow> | undefined
  readonly context: RepositoryContext
}

/**
 * Client-specific validation beyond the declared field constraints. Return an
 * empty array to accept; any issue returned fails the write with
 * ValidationFailedError.
 */
export type CustomValidatorSlot = (
  ctx: CustomValidatorContext,
) => Promise<readonly ValidationIssue[]> | readonly ValidationIssue[]

/**
 * The subset of the repository surface a slot may use inside the write's
 * transaction. Deliberately narrow: a slot that could start its own transaction
 * could deadlock against the write that invoked it.
 */
export interface TransactionalRepository {
  find(id: string): Promise<EntityRow | null>
  findMany(where?: Readonly<WritableValues>): Promise<EntityRow[]>
  create(values: WritableValues): Promise<EntityRow>
  update(id: string, patch: WritableValues, expectedRevision: number): Promise<EntityRow>
}

export interface DataSlots {
  beforePersist?: BeforePersistSlot
  afterPersist?: AfterPersistSlot
  customValidator?: CustomValidatorSlot
}

const slots: DataSlots = {}

/**
 * Wire the client's slot implementations. Called once at boot from the product's
 * generated bootstrap; calling it again replaces only the slots supplied.
 */
export function registerSlots(implementations: DataSlots): void {
  if (implementations.beforePersist !== undefined) slots.beforePersist = implementations.beforePersist
  if (implementations.afterPersist !== undefined) slots.afterPersist = implementations.afterPersist
  if (implementations.customValidator !== undefined) {
    slots.customValidator = implementations.customValidator
  }
}

export function getSlots(): Readonly<DataSlots> {
  return slots
}

/** Test helper. */
export function clearSlots(): void {
  delete slots.beforePersist
  delete slots.afterPersist
  delete slots.customValidator
}

/** The `proceed`/`reject` pair handed to a beforePersist slot. */
export function beforePersistControls(): Pick<BeforePersistContext, 'proceed' | 'reject'> {
  return {
    proceed: (data?: WritableValues): BeforePersistResult =>
      data === undefined ? { action: 'proceed' } : { action: 'proceed', data },
    reject: (reason: string): BeforePersistResult => ({ action: 'reject', reason }),
  }
}
