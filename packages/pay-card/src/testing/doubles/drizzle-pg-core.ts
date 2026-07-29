/**
 * Test double for drizzle-orm/pg-core.
 *
 * Enough of the builder API to let `schema.ts` load and to let a test read back
 * the declared column names and SQL types. It does not build queries — production
 * SQL lives in `db/postgres.ts` and is asserted there.
 */

export interface ColumnDescriptor {
  readonly name: string
  readonly sqlType: string
  notNull: boolean
  hasDefault: boolean
  primaryKey: boolean
}

export interface ColumnBuilder extends ColumnDescriptor {
  notNull(): ColumnBuilder
  default(value: unknown): ColumnBuilder
  defaultNow(): ColumnBuilder
  primaryKey(): ColumnBuilder
  references(fn: unknown): ColumnBuilder
  $type<T>(): ColumnBuilder
}

function column(name: string, sqlType: string): ColumnBuilder {
  const descriptor = {
    name,
    sqlType,
    notNull: false,
    hasDefault: false,
    primaryKey: false,
  } as unknown as ColumnBuilder
  const self = Object.assign(descriptor, {
    notNull: () => {
      ;(self as unknown as { notNull: boolean }).notNull = true
      return self
    },
    default: () => {
      ;(self as unknown as { hasDefault: boolean }).hasDefault = true
      return self
    },
    defaultNow: () => {
      ;(self as unknown as { hasDefault: boolean }).hasDefault = true
      return self
    },
    primaryKey: () => {
      ;(self as unknown as { primaryKey: boolean }).primaryKey = true
      return self
    },
    references: () => self,
    $type: () => self,
  })
  return self
}

export const text = (name: string): ColumnBuilder => column(name, 'text')
export const bigint = (name: string, _opts?: unknown): ColumnBuilder => column(name, 'bigint')
export const smallint = (name: string): ColumnBuilder => column(name, 'smallint')
export const integer = (name: string): ColumnBuilder => column(name, 'integer')
export const boolean = (name: string): ColumnBuilder => column(name, 'boolean')
export const jsonb = (name: string): ColumnBuilder => column(name, 'jsonb')
export const timestamp = (name: string, _opts?: unknown): ColumnBuilder =>
  column(name, 'timestamptz')

export const uniqueIndex = (name: string) => ({
  name,
  unique: true,
  on: (...columns: ColumnDescriptor[]) => ({ name, unique: true, columns }),
})

export const index = (name: string) => ({
  name,
  unique: false,
  on: (...columns: ColumnDescriptor[]) => ({ name, unique: false, columns }),
})

export interface TableDescriptor {
  readonly __tableName: string
  readonly __columns: Readonly<Record<string, ColumnDescriptor>>
  readonly __extras: unknown
  [key: string]: unknown
}

export function pgTable(
  name: string,
  columns: Record<string, ColumnBuilder>,
  extras?: (t: Record<string, ColumnBuilder>) => unknown,
): TableDescriptor {
  const table = {
    ...columns,
    __tableName: name,
    __columns: columns,
    __extras: extras === undefined ? {} : extras(columns),
  }
  return table as unknown as TableDescriptor
}
