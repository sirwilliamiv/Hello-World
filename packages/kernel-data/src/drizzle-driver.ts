/**
 * The Postgres driver, over Drizzle.
 *
 * Queries are built from `sql` fragments with bound parameters. Identifiers are
 * never interpolated from caller input: a table name comes from the entity
 * registry and a column name from the entity's declared fields, both of which
 * originate in a capability spec or the manifest. Anything else is refused
 * before it reaches this layer.
 *
 * The repository speaks camelCase; Postgres speaks snake_case. The translation
 * happens here and nowhere else.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type { DataDriver, Predicate, RowValues, SelectOptions } from './driver.js'

/**
 * A database handle or a transaction on one — the two are interchangeable for
 * everything this driver does.
 */
export interface Executor {
  execute(query: SQL): Promise<unknown>
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>
}

export type Database = PostgresJsDatabase<Record<string, never>>

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

export class DrizzleDriver implements DataDriver {
  constructor(private readonly executor: Executor) {}

  async select(table: string, where: Predicate, options: SelectOptions = {}): Promise<RowValues[]> {
    const query = sql`select * from ${identifier(table)}${whereClause(where)}${orderClause(options)}${limitClause(options)}`
    return this.rows(query)
  }

  async count(table: string, where: Predicate): Promise<number> {
    const rows = await this.rows(
      sql`select count(*)::int as count from ${identifier(table)}${whereClause(where)}`,
    )
    return Number(rows[0]?.['count'] ?? 0)
  }

  async insert(table: string, values: RowValues): Promise<RowValues> {
    const entries = Object.entries(values)
    const columns = sql.join(
      entries.map(([column]) => identifier(toColumn(column))),
      sql`, `,
    )
    const parameters = sql.join(
      entries.map(([, value]) => sql`${value}`),
      sql`, `,
    )
    const rows = await this.rows(
      sql`insert into ${identifier(table)} (${columns}) values (${parameters}) returning *`,
    )
    const row = rows[0]
    if (row === undefined) throw new Error(`insert into ${table} returned no row`)
    return row
  }

  async update(table: string, where: Predicate, values: RowValues): Promise<RowValues[]> {
    const assignments = sql.join(
      Object.entries(values).map(([column, value]) => sql`${identifier(toColumn(column))} = ${value}`),
      sql`, `,
    )
    return this.rows(
      sql`update ${identifier(table)} set ${assignments}${whereClause(where)} returning *`,
    )
  }

  async delete(table: string, where: Predicate): Promise<number> {
    const rows = await this.rows(
      sql`delete from ${identifier(table)}${whereClause(where)} returning id`,
    )
    return rows.length
  }

  transaction<T>(fn: (driver: DataDriver) => Promise<T>): Promise<T> {
    return this.executor.transaction((tx) => fn(new DrizzleDriver(tx)))
  }

  async executeSql(statement: string): Promise<void> {
    await this.executor.execute(sql.raw(statement))
  }

  private async rows(query: SQL): Promise<RowValues[]> {
    const result = (await this.executor.execute(query)) as unknown
    const raw = Array.isArray(result)
      ? (result as RowValues[])
      : ((result as { rows?: RowValues[] }).rows ?? [])
    return raw.map(fromRow)
  }
}

function identifier(name: string): SQL {
  const lowered = name.toLowerCase()
  if (!IDENTIFIER.test(lowered)) {
    throw new Error(`refusing to build SQL with the identifier ${JSON.stringify(name)}`)
  }
  // sql.identifier returns Name; wrap it so the declared SQL return type holds.
  return sql`${sql.identifier(lowered)}`
}

function whereClause(where: Predicate): SQL {
  const conditions: SQL[] = []

  for (const [column, value] of Object.entries(where.equals ?? {})) {
    conditions.push(
      value === null
        ? sql`${identifier(toColumn(column))} is null`
        : sql`${identifier(toColumn(column))} = ${value}`,
    )
  }
  for (const column of where.isNull ?? []) {
    conditions.push(sql`${identifier(toColumn(column))} is null`)
  }
  for (const column of where.isNotNull ?? []) {
    conditions.push(sql`${identifier(toColumn(column))} is not null`)
  }

  if (conditions.length === 0) return sql``
  return sql` where ${sql.join(conditions, sql` and `)}`
}

function orderClause(options: SelectOptions): SQL {
  const orderBy = options.orderBy ?? []
  if (orderBy.length === 0) return sql``
  const terms = orderBy.map((order) =>
    order.direction === 'desc'
      ? sql`${identifier(toColumn(order.column))} desc`
      : sql`${identifier(toColumn(order.column))} asc`,
  )
  return sql` order by ${sql.join(terms, sql`, `)}`
}

function limitClause(options: SelectOptions): SQL {
  let clause = sql``
  if (options.limit !== undefined) clause = sql`${clause} limit ${options.limit}`
  if (options.offset !== undefined) clause = sql`${clause} offset ${options.offset}`
  return clause
}

/** `organizationId` → `organization_id`. */
export function toColumn(property: string): string {
  return property.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** `organization_id` → `organizationId`. */
export function toProperty(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase())
}

function fromRow(row: RowValues): RowValues {
  const mapped: RowValues = {}
  for (const [column, value] of Object.entries(row)) {
    mapped[toProperty(column)] = value
  }
  return mapped
}
