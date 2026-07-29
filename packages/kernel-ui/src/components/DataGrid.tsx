'use client'

/**
 * DataGrid — Table plus search, filter, sort, pagination and selection.
 *
 * Client component. All of the actual logic lives in `datagrid-model.ts`, which
 * is pure and tested there; this file is the rendering and the state.
 */

import { useMemo, useState, type ReactNode } from 'react'

import { Table, type TableColumn } from './Table.js'
import { cx } from './cx.js'
import {
  applyQuery,
  defaultQuery,
  stringify,
  toggleSort,
  valueOf,
  type DataGridColumn,
  type DataGridQuery,
  type DataGridSort,
} from './datagrid-model.js'

export interface DataGridBulkAction<Row> {
  readonly id: string
  readonly label: string
  readonly destructive?: boolean
  readonly run: (rows: readonly Row[]) => Promise<void> | void
}

export interface DataGridProps<Row> {
  readonly columns: readonly DataGridColumn<Row>[]
  readonly rows: readonly Row[]
  readonly rowKey: (row: Row) => string
  readonly caption?: ReactNode
  readonly pageSize?: number
  readonly searchPlaceholder?: string
  readonly empty?: ReactNode
  readonly selectable?: boolean
  readonly bulkActions?: readonly DataGridBulkAction<Row>[]
  readonly className?: string
  /** Rendered at the end of the toolbar — usually an export button. */
  readonly toolbar?: ReactNode
}

export function DataGrid<Row>({
  columns,
  rows,
  rowKey,
  caption,
  pageSize = defaultQuery.pageSize,
  searchPlaceholder = 'Search',
  empty,
  selectable = false,
  bulkActions = [],
  className,
  toolbar,
}: DataGridProps<Row>) {
  const [query, setQuery] = useState<DataGridQuery>({ ...defaultQuery, pageSize })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const page = useMemo(() => applyQuery(rows, columns, query), [rows, columns, query])

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(rowKey(row))),
    [rows, rowKey, selected],
  )

  const setSort = (key: string) => {
    setQuery((current) => ({ ...current, sort: toggleSort(current.sort, key), page: 1 }))
  }

  const tableColumns: TableColumn<Row>[] = []

  if (selectable) {
    tableColumns.push({
      key: '__select',
      width: '2.5rem',
      header: (
        <input
          type="checkbox"
          aria-label="Select all rows on this page"
          checked={page.rows.length > 0 && page.rows.every((row) => selected.has(rowKey(row)))}
          onChange={(event) => {
            setSelected((current) => {
              const next = new Set(current)
              for (const row of page.rows) {
                if (event.target.checked) next.add(rowKey(row))
                else next.delete(rowKey(row))
              }
              return next
            })
          }}
        />
      ),
      cell: (row) => (
        <input
          type="checkbox"
          aria-label={`Select ${rowKey(row)}`}
          checked={selected.has(rowKey(row))}
          onChange={(event) => {
            setSelected((current) => {
              const next = new Set(current)
              if (event.target.checked) next.add(rowKey(row))
              else next.delete(rowKey(row))
              return next
            })
          }}
        />
      ),
    })
  }

  for (const column of columns) {
    tableColumns.push({
      key: column.key,
      ...(column.numeric === undefined ? {} : { numeric: column.numeric }),
      ...(column.width === undefined ? {} : { width: column.width }),
      header:
        column.sortable === false ? (
          column.header
        ) : (
          <button
            type="button"
            className="fui-table__sort"
            onClick={() => setSort(column.key)}
            aria-label={`Sort by ${column.key}`}
          >
            {column.header}
            <span aria-hidden="true">{sortGlyph(query.sort, column.key)}</span>
          </button>
        ),
      cell: (row) =>
        column.cell === undefined ? stringify(valueOf(column, row)) : column.cell(row),
    })
  }

  const filterColumns = columns.filter((column) => column.filterOptions !== undefined)

  return (
    <div className={cx('fui-datagrid', className)}>
      <div className="fui-datagrid__toolbar">
        <div className="fui-datagrid__search">
          <input
            type="search"
            className="fui-input"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={query.search}
            onChange={(event) =>
              setQuery((current) => ({ ...current, search: event.target.value, page: 1 }))
            }
          />
        </div>
        <div className="fui-datagrid__filters">
          {filterColumns.map((column) => (
            <select
              key={column.key}
              className="fui-select"
              aria-label={`Filter by ${column.key}`}
              value={query.filters[column.key] ?? ''}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  filters: { ...current.filters, [column.key]: event.target.value },
                  page: 1,
                }))
              }
            >
              <option value="">All</option>
              {(column.filterOptions ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ))}
        </div>
        {toolbar}
      </div>

      {selectable && selected.size > 0 ? (
        <div className="fui-datagrid__selection">
          <span>{selected.size} selected</span>
          {bulkActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={cx(
                'fui-button',
                'fui-button--sm',
                action.destructive === true ? 'fui-button--danger' : 'fui-button--secondary',
              )}
              onClick={() => {
                void action.run(selectedRows)
              }}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="fui-button fui-button--ghost fui-button--sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      ) : null}

      <Table
        {...(caption === undefined ? {} : { caption })}
        {...(empty === undefined ? {} : { empty })}
        columns={tableColumns}
        rows={page.rows}
        rowKey={(row) => rowKey(row)}
      />

      <div className="fui-datagrid__footer">
        <span>
          {page.total === 0
            ? 'No matching rows'
            : `${page.total} row${page.total === 1 ? '' : 's'}`}
        </span>
        <div className="fui-datagrid__pager">
          <button
            type="button"
            className="fui-button fui-button--secondary fui-button--sm"
            disabled={page.page <= 1}
            onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
          >
            Previous
          </button>
          <span>
            Page {page.page} of {page.pageCount}
          </span>
          <button
            type="button"
            className="fui-button fui-button--secondary fui-button--sm"
            disabled={page.page >= page.pageCount}
            onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}

function sortGlyph(sort: DataGridSort | undefined, key: string): string {
  if (sort === undefined || sort.key !== key) return '↕'
  return sort.direction === 'asc' ? '↑' : '↓'
}
