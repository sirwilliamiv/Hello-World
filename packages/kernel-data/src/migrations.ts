/**
 * The migration runner.
 *
 * Migrations are hand-written, reviewed SQL shipped by the capability that needs
 * them, applied in graph order, and recorded in a ledger with a checksum
 * (ARCHITECTURE.md 14.1). Two properties matter more than anything else here:
 *
 *   1. **Every migration has a rollback.** Publication fails without one, and
 *      this runner refuses to roll back what it cannot roll back rather than
 *      leaving an operator to guess.
 *   2. **A published migration is immutable.** If the file on disk no longer
 *      matches the checksum recorded when it was applied, the run stops. A
 *      quietly edited migration is how two clients end up with different schemas
 *      and the same ledger.
 *
 * The generated `migrate.ts` calls this with the resolved graph's migration list:
 *
 *     void runMigrations([{ capability: 'kernel.data', id: '20260601_create_kernel_data',
 *                           up: 'migrations/...up.sql', down: 'migrations/...down.sql' }])
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { getDriver, getLogger, now } from './db.js'
import type { DataDriver } from './driver.js'
import { MigrationError, MigrationChecksumMismatchError } from './errors.js'

export const MIGRATION_TABLE = 'forge_migrations'

/** A migration shipped as SQL files — the normal case. */
export interface MigrationDescriptor {
  readonly capability: string
  readonly id: string
  /** Path to the forward script, relative to the application root. */
  readonly up: string
  /** Path to the rollback script. Empty only for the generated client entities. */
  readonly down: string
  readonly description?: string
}

/**
 * A migration expressed in code. Matches the `Migration` interface in the
 * capability spec's `exposes` block. Used for data backfills that SQL cannot
 * express.
 */
export interface Migration {
  readonly id: string
  readonly capability?: string
  up(db: DataDriver): Promise<void>
  down(db: DataDriver): Promise<void>
}

export type MigrationInput = MigrationDescriptor | Migration

export interface MigrationLedgerEntry {
  readonly id: string
  readonly capability: string
  readonly checksum: string
  readonly rollbackAvailable: boolean
  readonly appliedSerial: number
  readonly appliedAt: Date
}

export interface MigrationRunOptions {
  /** Root the descriptor paths are resolved against. Defaults to the process cwd. */
  readonly root?: string
  /** Driver to run against. Defaults to the configured one. */
  readonly driver?: DataDriver
  /** Report what would run without applying anything. */
  readonly dryRun?: boolean
}

export interface MigrationRunResult {
  readonly applied: string[]
  readonly skipped: string[]
}

function isDescriptor(migration: MigrationInput): migration is MigrationDescriptor {
  return typeof (migration as MigrationDescriptor).up === 'string'
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readScript(path: string, root: string): Promise<string> {
  const full = isAbsolute(path) ? path : resolve(root, path)
  return readFile(full, 'utf8')
}

/** Create the ledger if this is the first run. Idempotent. */
async function ensureLedger(driver: DataDriver): Promise<void> {
  await driver.executeSql(`
    create table if not exists ${MIGRATION_TABLE} (
      id text primary key,
      capability text not null,
      checksum text not null,
      rollback_available boolean not null default true,
      applied_serial integer not null,
      applied_at timestamptz not null default now()
    )
  `)
}

export async function appliedMigrations(
  options: MigrationRunOptions = {},
): Promise<MigrationLedgerEntry[]> {
  const driver = options.driver ?? getDriver()
  await ensureLedger(driver)
  const rows = await driver.select(
    MIGRATION_TABLE,
    {},
    { orderBy: [{ column: 'appliedSerial', direction: 'asc' }] },
  )
  return rows.map((row) => ({
    id: String(row['id']),
    capability: String(row['capability']),
    checksum: String(row['checksum']),
    rollbackAvailable: row['rollbackAvailable'] !== false,
    appliedSerial: Number(row['appliedSerial'] ?? 0),
    appliedAt: row['appliedAt'] instanceof Date ? row['appliedAt'] : new Date(0),
  }))
}

/**
 * Apply every migration that has not been applied yet, in the order given.
 *
 * The order is the resolved graph's order, which respects `requires` — a
 * capability's tables exist before the tables that reference them. Sorting by id
 * instead would interleave capabilities by date and break that.
 */
export async function runMigrations(
  migrations: readonly MigrationInput[],
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const driver = options.driver ?? getDriver()
  const root = options.root ?? process.cwd()
  const logger = getLogger()

  await ensureLedger(driver)
  const ledger = await appliedMigrations({ ...options, driver })
  const byId = new Map(ledger.map((entry) => [entry.id, entry]))
  let serial = ledger.reduce((max, entry) => Math.max(max, entry.appliedSerial), 0)

  const applied: string[] = []
  const skipped: string[] = []

  for (const migration of migrations) {
    const capability = migration.capability ?? '<unknown>'
    const script = isDescriptor(migration) ? await readScript(migration.up, root) : undefined
    const checksum = checksumOf(script ?? `code:${migration.id}`)
    const recorded = byId.get(migration.id)

    if (recorded !== undefined) {
      if (recorded.checksum !== checksum) {
        throw new MigrationChecksumMismatchError(migration.id, recorded.checksum, checksum)
      }
      skipped.push(migration.id)
      continue
    }

    if (options.dryRun === true) {
      applied.push(migration.id)
      continue
    }

    serial += 1
    const currentSerial = serial
    const rollbackAvailable = isDescriptor(migration) ? migration.down !== '' : true

    try {
      await driver.transaction(async (tx) => {
        if (script !== undefined) await tx.executeSql(script)
        else await (migration as Migration).up(tx)

        await tx.insert(MIGRATION_TABLE, {
          id: migration.id,
          capability,
          checksum,
          rollbackAvailable,
          appliedSerial: currentSerial,
          appliedAt: now(),
        })
      })
    } catch (error) {
      throw new MigrationError(
        `migration ${migration.id} (${capability}) failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    logger.warn(`applied migration ${migration.id}`, { capability, serial: currentSerial })
    applied.push(migration.id)
  }

  return { applied, skipped }
}

/**
 * Roll one migration back and remove it from the ledger.
 *
 * The migration must be in the list passed in, because the rollback script ships
 * with the capability rather than with the ledger — the ledger records that a
 * rollback exists, not what it says.
 */
export async function rollbackMigration(
  id: string,
  migrations: readonly MigrationInput[],
  options: MigrationRunOptions = {},
): Promise<void> {
  const driver = options.driver ?? getDriver()
  const root = options.root ?? process.cwd()

  await ensureLedger(driver)
  const ledger = await appliedMigrations({ ...options, driver })
  const recorded = ledger.find((entry) => entry.id === id)
  if (recorded === undefined) {
    throw new MigrationError(`migration ${id} is not applied; nothing to roll back`)
  }

  const migration = migrations.find((candidate) => candidate.id === id)
  if (migration === undefined) {
    throw new MigrationError(
      `migration ${id} is applied but is not in the migration list: it belongs to a capability that is no longer in the graph, so its rollback script is unavailable`,
    )
  }

  if (isDescriptor(migration) && migration.down === '') {
    throw new MigrationError(
      `migration ${id} ships no rollback script. A migration without a tested rollback fails publication, so this state should be unreachable.`,
    )
  }

  await driver.transaction(async (tx) => {
    if (isDescriptor(migration)) await tx.executeSql(await readScript(migration.down, root))
    else await (migration as Migration).down(tx)
    await tx.delete(MIGRATION_TABLE, { equals: { id } })
  })
}

/** Roll back every applied migration, newest first. Used by the migration tests. */
export async function rollbackAll(
  migrations: readonly MigrationInput[],
  options: MigrationRunOptions = {},
): Promise<string[]> {
  const ledger = await appliedMigrations(options)
  const order = [...ledger].sort((a, b) => b.appliedSerial - a.appliedSerial)
  const rolledBack: string[] = []
  for (const entry of order) {
    await rollbackMigration(entry.id, migrations, options)
    rolledBack.push(entry.id)
  }
  return rolledBack
}
