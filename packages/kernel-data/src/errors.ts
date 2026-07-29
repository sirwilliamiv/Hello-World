/**
 * Errors raised by the data layer.
 *
 * Each one corresponds to a rule that the repository enforces rather than
 * documents. A rule that is only documented is a rule that twenty client
 * repositories will each break differently.
 */

export class DataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A query or write referenced an entity that was never registered. */
export class EntityNotRegisteredError extends DataError {
  constructor(readonly entity: string) {
    super(
      `entity ${JSON.stringify(entity)} is not registered: add it to a capability's \`owns\` block or to the manifest's entities, so it is registered from src/generated/kernel.data/entities.ts`,
    )
  }
}

/** A row that should exist does not, or is soft-deleted and was not asked for. */
export class EntityNotFoundError extends DataError {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`)
  }
}

/**
 * Update or delete was attempted on an append-only entity.
 *
 * Ledger entries, audit records and the event log are corrected by writing new
 * rows, never by editing old ones. Enforced here rather than by convention,
 * because a convention does not survive a capability author in a hurry.
 */
export class AppendOnlyViolationError extends DataError {
  constructor(
    readonly entity: string,
    readonly operation: string,
  ) {
    super(
      `${entity} is append-only: ${operation} is not permitted. Corrections to an append-only entity are new rows, not edits.`,
    )
  }
}

/**
 * The row changed since it was read. The write is refused rather than applied
 * over the top of someone else's change.
 */
export class StaleWriteError extends DataError {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expectedRevision: number,
    readonly actualRevision?: number,
  ) {
    super(
      `stale write to ${entity} ${id}: expected revision ${String(expectedRevision)}` +
        (actualRevision === undefined
          ? ' but the row has since changed'
          : `, found ${String(actualRevision)}`) +
        '. Re-read the row and re-apply the change.',
    )
  }
}

/**
 * A tenant-scoped entity was accessed without a tenant in context.
 *
 * This is the check that makes multi-tenancy structural: a capability cannot
 * issue an unscoped query without bypassing the repository, and bypassing the
 * repository is a CI failure (ARCHITECTURE.md 9.3, 14.2).
 */
export class TenantScopeError extends DataError {
  constructor(readonly entity: string) {
    super(
      `${entity} is tenant-scoped and no tenant is in context: pass a RepositoryContext with tenantId, or use systemContext() for a deliberate cross-tenant operation`,
    )
  }
}

/** A write failed declared field validation or a customValidator slot. */
export class ValidationFailedError extends DataError {
  constructor(
    readonly entity: string,
    readonly issues: readonly string[],
  ) {
    super(`${entity} failed validation: ${issues.join('; ')}`)
  }
}

/** A beforePersist slot rejected the write. */
export class WriteRejectedError extends DataError {
  constructor(
    readonly entity: string,
    readonly reason: string,
  ) {
    super(`write to ${entity} rejected by the beforePersist slot: ${reason}`)
  }
}

/** A migration on disk no longer matches the one that was applied. */
export class MigrationChecksumMismatchError extends DataError {
  constructor(
    readonly id: string,
    readonly appliedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `migration ${id} has changed since it was applied (was ${appliedChecksum.slice(0, 12)}, now ${currentChecksum.slice(0, 12)}): a published migration is immutable — ship a new one instead`,
    )
  }
}

/** A migration failed, or a rollback was requested for one that has none. */
export class MigrationError extends DataError {}

/** The data layer was used before a driver was configured. */
export class DataNotConfiguredError extends DataError {
  constructor() {
    super(
      'the data layer has no driver: call configureData({ database }) at boot, or configureData({ driver: new InMemoryDriver() }) in a test',
    )
  }
}
