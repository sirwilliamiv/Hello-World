/**
 * Table — the presentational primitive.
 *
 * Server component. Rows are already-rendered cells; nothing here sorts,
 * filters or paginates. That is DataGrid's job, and keeping the two separate is
 * what lets kernel.admin render a read-only entity list with no client
 * JavaScript at all.
 */

import type { ReactNode } from 'react'

import { cx } from './cx.js'

export interface TableColumn<Row> {
  readonly key: string
  readonly header: ReactNode
  /** Right-aligned, tabular numerals. */
  readonly numeric?: boolean
  readonly width?: string
  readonly cell: (row: Row, index: number) => ReactNode
}

export interface TableProps<Row> {
  readonly caption?: ReactNode
  readonly columns: readonly TableColumn<Row>[]
  readonly rows: readonly Row[]
  readonly rowKey: (row: Row, index: number) => string
  readonly empty?: ReactNode
  readonly className?: string
}

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  empty = 'Nothing to show.',
  className,
}: TableProps<Row>) {
  return (
    <div className="fui-table-wrap">
      <table className={cx('fui-table', className)}>
        {caption === undefined ? null : (
          <caption className="fui-visually-hidden">{caption}</caption>
        )}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width === undefined ? undefined : { width: column.width }}
                className={cx(column.numeric === true && 'fui-table__cell--numeric')}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="fui-table__empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={rowKey(row, index)}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(column.numeric === true && 'fui-table__cell--numeric')}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
