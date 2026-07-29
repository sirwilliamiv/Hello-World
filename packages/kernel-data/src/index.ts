/**
 * @forge/kernel-data — the runtime half of kernel.data@1.0.0
 *
 * Entity definition, migration running with rollback, soft delete, timestamps,
 * optimistic locking, and the mechanism by which manifest-declared client
 * entities become real tables. The universal entity events published from here
 * are the backbone of the system: search indexing, audit logging, webhooks,
 * automation rules and reporting all subscribe to them rather than coupling to
 * individual capabilities.
 *
 * Spec: catalog/kernel/kernel.data.capability.json
 */

export { Repository, type EntityRepository } from './repository.js'

export {
  clearEntities,
  defaultTableName,
  entities,
  entitiesOwnedBy,
  getEntity,
  isRegistered,
  listEntities,
  registerEntity,
  tryGetEntity,
} from './registry.js'

export {
  appliedMigrations,
  rollbackAll,
  rollbackMigration,
  runMigrations,
  MIGRATION_TABLE,
  type Migration,
  type MigrationDescriptor,
  type MigrationInput,
  type MigrationLedgerEntry,
  type MigrationRunOptions,
  type MigrationRunResult,
} from './migrations.js'

export {
  configureData,
  getDriver,
  getLogger,
  isConfigured,
  newId,
  now,
  resetData,
  type DataConfiguration,
  type DataLogger,
} from './db.js'

export {
  InMemoryDriver,
  type DataDriver,
  type Predicate,
  type RowValues,
  type SelectOptions,
} from './driver.js'

export { DrizzleDriver, toColumn, toProperty, type Database, type Executor } from './drizzle-driver.js'

export {
  beforePersistControls,
  clearSlots,
  getSlots,
  registerSlots,
  type AfterPersistContext,
  type AfterPersistSlot,
  type BeforePersistContext,
  type BeforePersistResult,
  type BeforePersistSlot,
  type CustomValidatorContext,
  type CustomValidatorSlot,
  type DataSlots,
  type PersistOperation,
  type TransactionalRepository,
  type ValidationIssue,
} from './slots.js'

export {
  changedFields,
  emitEntityEvent,
  ENTITY_EVENT_CONTRACT_VERSION,
  entityCreatedPayload,
  entityDeletedPayload,
  entityRestoredPayload,
  entityUpdatedPayload,
  registerEntityEventSchemas,
  type EntityCreatedPayload,
  type EntityDeletedPayload,
  type EntityRestoredPayload,
  type EntityUpdatedPayload,
} from './events.js'

export { clearValidationCache, validateValues, type ValidationOutcome } from './validate.js'

export {
  forgeMigrations,
  managedColumns,
  tenantColumn,
  type ForgeMigrationRow,
} from './schema.js'

export {
  AppendOnlyViolationError,
  DataError,
  DataNotConfiguredError,
  EntityNotFoundError,
  EntityNotRegisteredError,
  MigrationChecksumMismatchError,
  MigrationError,
  StaleWriteError,
  TenantScopeError,
  ValidationFailedError,
  WriteRejectedError,
} from './errors.js'

export { systemContext } from './types.js'
export type {
  EntityDefinition,
  EntityName,
  EntityRegistration,
  EntityRow,
  FieldDefinition,
  FieldType,
  FindManyOptions,
  FindOptions,
  ManagedRow,
  OrderBy,
  RepositoryContext,
  WritableValues,
} from './types.js'
