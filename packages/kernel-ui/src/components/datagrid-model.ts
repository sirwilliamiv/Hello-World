/**
 * DataGrid query model.
 *
 * Pure, React-free, and separate from the component on purpose: kernel.admin
 * runs the identical search/filter/sort/page logic on the server against a
 * `Repository<T>` for large tables, and in the browser for small ones. If the
 * two disagreed, an admin would see a different result depending on row count,
 * which is the sort of bug nobody reports and everybody distrusts.
 */

import type { ReactNode } from 'react'

export type SortDirection = 'asc' | 'desc'

export interface DataGridFilterOption {
  readonly value: string
  readonly label: string
}

export interface DataGridColumn<Row> {
  readonly key: string
  readonly header: ReactNode
  /** The comparable/searchable value. Defaults to `row[key]`. */
  readonly accessor?: (row: Row) => unknown
  /** Rendering. Defaults to the accessor's value, stringified. */
  readonly cell?: (row: Row) => ReactNode
  readonly numeric?: boolean
  readonly sortable?: boolean
  /** Include this column in free-text search. */
  readonly searchable?: boolean
  /** Present a select filter with these options. */
  readonly filterOptions?: readonly DataGridFilterOption[]
  readonly width?: string
}

export interface DataGridSort {
  readonly key: string
  readonly direction: SortDirection
}

export interface DataGridQuery {
  readonly search: string
  readonly filters: Readonly<Record<string, string>>
  readonly sort: DataGridSort | undefined
  readonly page: number
  readonly pageSize: number
}

export interface DataGridPage<Row> {
  readonly rows: readonly Row[]
  /** Rows matching the query, before pagination. */
  readonly total: number
  readonly pageCount: number
  readonly page: number
}

export const defaultQuery: DataGridQuery = {
  search: '',
  filters: {},
  sort: undefined,
  page: 1,
  pageSize: 25,
}

export function valueOf<Row>(column: DataGridColumn<Row>, row: Row): unknown {
  if (column.accessor !== undefined) return column.accessor(row)
  return (row as Record<string, unknown>)[column.key]
}

/** Stringification used for search, filtering and the default cell. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  return String(value)
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return stringify(a).localeCompare(stringify(b), undefined, { numeric: true })
}

/**
 * Filter, search, sort and paginate. Never mutates `rows`.
 *
 * Sorting is stable and falls back to the original index, so equal keys keep a
 * deterministic order across renders.
 */
export function applyQuery<Row>(
  rows: readonly Row[],
  columns: readonly DataGridColumn<Row>[],
  query: DataGridQuery,
): DataGridPage<Row> {
  const byKey = new Map(columns.map((column) => [column.key, column]))

  let matched = rows.filter((row) => {
    for (const [key, wanted] of Object.entries(query.filters)) {
      if (wanted === '') continue
      const column = byKey.get(key)
      if (column === undefined) continue
      if (stringify(valueOf(column, row)) !== wanted) return false
    }
    return true
  })

  const needle = query.search.trim().toLowerCase()
  if (needle !== '') {
    const searchable = columns.filter(
      (column) => column.searchable !== false && column.filterOptions === undefined,
    )
    matched = matched.filter((row) =>
      searchable.some((column) =>
        stringify(valueOf(column, row)).toLowerCase().includes(needle),
      ),
    )
  }

  const sort = query.sort
  if (sort !== undefined) {
    const column = byKey.get(sort.key)
    if (column !== undefined) {
      const indexed = matched.map((row, index) => ({ row, index }))
      indexed.sort((a, b) => {
        const result = compare(valueOf(column, a.row), valueOf(column, b.row))
        if (result !== 0) return sort.direction === 'asc' ? result : -result
        return a.index - b.index
      })
      matched = indexed.map((entry) => entry.row)
    }
  }

  const pageSize = Math.max(1, query.pageSize)
  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize))
  const page = Math.min(Math.max(1, query.page), pageCount)
  const start = (page - 1) * pageSize

  return {
    rows: matched.slice(start, start + pageSize),
    total: matched.length,
    pageCount,
    page,
  }
}

/** Cycle a column through asc → desc → unsorted. */
export function toggleSort(
  current: DataGridSort | undefined,
  key: string,
): DataGridSort | undefined {
  if (current === undefined || current.key !== key) return { key, direction: 'asc' }
  if (current.direction === 'asc') return { key, direction: 'desc' }
  return undefined
}

/** RFC 4180 CSV. Used by the admin export path. */
export function toCsv<Row>(
  rows: readonly Row[],
  columns: readonly DataGridColumn<Row>[],
): string {
  const escape = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

  const header = columns.map((column) => escape(column.key)).join(',')
  const body = rows.map((row) =>
    columns.map((column) => escape(stringify(valueOf(column, row)))).join(','),
  )
  return [header, ...body].join('\r\n')
}
