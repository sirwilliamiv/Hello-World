/**
 * The generated list view.
 *
 * One component for every entity in the graph. There is no per-entity list
 * component anywhere in this package, and there must not be: the moment one
 * exists, declaring an entity in the manifest stops buying a working admin
 * surface and starts buying a to-do.
 */

import { Card, DataGrid, type DataGridColumn } from '@forge/kernel-ui'

import type { Row } from '../ports/repository.js'
import type { AdminListView } from '../resolve.js'

export interface EntityListViewProps {
  readonly view: AdminListView
  readonly rows: readonly Row[]
  readonly total: number
  /** Whether the viewer additionally holds `admin.export`. */
  readonly canExport?: boolean
}

function toGridColumns(view: AdminListView): DataGridColumn<Row>[] {
  return view.columns.map((column) => {
    const filter = view.filters.find((f) => f.field === column.name)
    return {
      key: column.name,
      header: column.label,
      accessor: (row: Row) => row[column.name],
      sortable: column.sortable,
      ...(column.numeric ? { numeric: true } : {}),
      ...(column.width === undefined ? {} : { width: column.width }),
      ...(filter === undefined
        ? {}
        : {
            filterOptions: filter.options.map((option) => ({
              value: option.value,
              label: option.label,
            })),
          }),
      ...(column.name === 'id'
        ? {
            cell: (row: Row) => (
              <a href={`${view.path}/${String(row['id'])}`}>{String(row['id'])}</a>
            ),
          }
        : {}),
    }
  })
}

export function EntityListView({ view, rows, total, canExport = false }: EntityListViewProps) {
  return (
    <Card
      title={view.pluralLabel}
      description={`${total} record${total === 1 ? '' : 's'} · owned by ${view.owner}`}
      actions={
        <>
          {canExport ? (
            <a
              className="fui-button fui-button--secondary fui-button--sm"
              href={`${view.path}/export`}
              download
            >
              Export CSV
            </a>
          ) : null}
          {view.canCreate ? (
            <a className="fui-button fui-button--primary fui-button--sm" href={`${view.path}/new`}>
              New {view.label}
            </a>
          ) : null}
        </>
      }
      flush
    >
      <DataGrid
        columns={toGridColumns(view)}
        rows={rows}
        rowKey={(row) => String(row['id'] ?? JSON.stringify(row))}
        pageSize={view.pageSize}
        caption={`${view.pluralLabel} list`}
        selectable={view.bulkActions.length > 0}
        searchPlaceholder={`Search ${view.pluralLabel.toLowerCase()}`}
        empty={`No ${view.pluralLabel.toLowerCase()} yet.`}
      />
    </Card>
  )
}
