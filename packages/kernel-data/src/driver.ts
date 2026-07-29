/**
 * The storage port.
 *
 * Everything that makes the repository *the* data access path — tenant scoping,
 * append-only enforcement, soft delete, timestamps, optimistic locking, entity
 * events, slots — lives above this interface, in repository.ts. A driver does
 * nothing but move rows.
 *
 * That split is what lets the identical enforcement run against Postgres in a
 * product and in memory in a test, and it is why the policy tests below are real
 * tests rather than mocks of the thing being tested.
 *
 * Drivers are internal plumbing. A capability that reaches for one instead of a
 * Repository has bypassed tenant scoping, and the import rules in
 * ARCHITECTURE.md 9.3 exist to catch exactly that.
 */

import type { OrderBy } from './types.js'

export type RowValues = Record<string, unknown>

export interface Predicate {
  /** Column equality, ANDed. A null value means IS NULL. */
  readonly equals?: Readonly<RowValues>
  readonly isNull?: readonly string[]
  readonly isNotNull?: readonly string[]
}

export interface SelectOptions {
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: readonly OrderBy[]
}

export interface DataDriver {
  select(table: string, where: Predicate, options?: SelectOptions): Promise<RowValues[]>
  count(table: string, where: Predicate): Promise<number>
  insert(table: string, values: RowValues): Promise<RowValues>
  /** Returns the rows actually updated — an empty array is how a stale write is detected. */
  update(table: string, where: Predicate, values: RowValues): Promise<RowValues[]>
  /** Hard delete. Only ever reached through an explicit purge, never through softDelete. */
  delete(table: string, where: Predicate): Promise<number>
  transaction<T>(fn: (driver: DataDriver) => Promise<T>): Promise<T>
  /**
   * Execute a statement verbatim. Exists for the migration runner, which applies
   * hand-written, reviewed SQL — and for nothing else. It is not a general
   * escape hatch: a capability issuing raw SQL has bypassed tenant scoping.
   */
  executeSql(statement: string): Promise<void>
}

/**
 * In-memory driver.
 *
 * Used by tests and by the repository's own test suite. It implements the same
 * port as the Postgres driver, so a rule proven here is the rule that runs in
 * production.
 */
export class InMemoryDriver implements DataDriver {
  private tables = new Map<string, Map<string, RowValues>>()

  private tableOf(table: string): Map<string, RowValues> {
    const existing = this.tables.get(table)
    if (existing !== undefined) return existing
    const created = new Map<string, RowValues>()
    this.tables.set(table, created)
    return created
  }

  select(table: string, where: Predicate, options: SelectOptions = {}): Promise<RowValues[]> {
    let rows = [...this.tableOf(table).values()].filter((row) => matches(row, where))

    for (const order of [...(options.orderBy ?? [])].reverse()) {
      const direction = order.direction === 'desc' ? -1 : 1
      rows = rows.sort((a, b) => compare(a[order.column], b[order.column]) * direction)
    }

    const offset = options.offset ?? 0
    const end = options.limit === undefined ? undefined : offset + options.limit
    return Promise.resolve(rows.slice(offset, end).map((row) => ({ ...row })))
  }

  count(table: string, where: Predicate): Promise<number> {
    return Promise.resolve(
      [...this.tableOf(table).values()].filter((row) => matches(row, where)).length,
    )
  }

  insert(table: string, values: RowValues): Promise<RowValues> {
    const id = String(values['id'])
    const row = { ...values }
    this.tableOf(table).set(id, row)
    return Promise.resolve({ ...row })
  }

  update(table: string, where: Predicate, values: RowValues): Promise<RowValues[]> {
    const updated: RowValues[] = []
    for (const [id, row] of this.tableOf(table)) {
      if (!matches(row, where)) continue
      const next = { ...row, ...values }
      this.tableOf(table).set(id, next)
      updated.push({ ...next })
    }
    return Promise.resolve(updated)
  }

  delete(table: string, where: Predicate): Promise<number> {
    let removed = 0
    for (const [id, row] of [...this.tableOf(table)]) {
      if (!matches(row, where)) continue
      this.tableOf(table).delete(id)
      removed += 1
    }
    return Promise.resolve(removed)
  }

  /**
   * Snapshot-and-restore transaction. Enough to prove that an afterPersist slot
   * failing rolls the write back; it is not MVCC, and it does not pretend to be.
   */
  async transaction<T>(fn: (driver: DataDriver) => Promise<T>): Promise<T> {
    const snapshot = new Map<string, Map<string, RowValues>>()
    for (const [name, rows] of this.tables) {
      const copy = new Map<string, RowValues>()
      for (const [id, row] of rows) copy.set(id, { ...row })
      snapshot.set(name, copy)
    }

    try {
      return await fn(this)
    } catch (error) {
      this.tables = snapshot
      throw error
    }
  }

  /**
   * Migrations are SQL and there is no SQL engine here. Statements are recorded
   * so that a test can assert the runner's ordering, ledger and rollback
   * behaviour — the parts that are this package's responsibility — without
   * standing up Postgres.
   */
  readonly statements: string[] = []

  executeSql(statement: string): Promise<void> {
    this.statements.push(statement)
    return Promise.resolve()
  }

  /** Test helper. */
  reset(): void {
    this.tables.clear()
    this.statements.length = 0
  }
}

function matches(row: RowValues, where: Predicate): boolean {
  for (const [column, value] of Object.entries(where.equals ?? {})) {
    const actual = row[column]
    if (value === null) {
      if (actual !== null && actual !== undefined) return false
      continue
    }
    if (actual instanceof Date && value instanceof Date) {
      if (actual.getTime() !== value.getTime()) return false
      continue
    }
    if (actual !== value) return false
  }
  for (const column of where.isNull ?? []) {
    const actual = row[column]
    if (actual !== null && actual !== undefined) return false
  }
  for (const column of where.isNotNull ?? []) {
    const actual = row[column]
    if (actual === null || actual === undefined) return false
  }
  return true
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}
