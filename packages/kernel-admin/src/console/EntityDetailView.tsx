/**
 * The generated detail view. One component for every entity, for the same
 * reason as EntityListView.
 */

import { Card, Table, stringify } from '@forge/kernel-ui'

import type { Row } from '../ports/repository.js'
import type { AdminDetailView, AdminField } from '../resolve.js'

export interface EntityDetailViewProps {
  readonly view: AdminDetailView
  readonly row: Row
}

function renderValue(field: AdminField, row: Row): string {
  const value = row[field.name]
  if (value === null || value === undefined) return '—'
  if (field.control === 'checkbox') return value === true ? 'Yes' : 'No'
  if (field.control === 'json') return JSON.stringify(value, null, 2)
  return stringify(value)
}

export function EntityDetailView({ view, row }: EntityDetailViewProps) {
  const title = stringify(row[view.titleField]) || stringify(row['id'])

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      {view.sections.map((section) => (
        <Card
          key={section.title}
          title={section.title}
          {...(section === view.sections[0] ? { description: `${view.label} · ${title}` } : {})}
          flush
          actions={
            section === view.sections[0] && view.canEdit ? (
              <a
                className="fui-button fui-button--secondary fui-button--sm"
                href={`${view.path(String(row['id']))}/edit`}
              >
                Edit
              </a>
            ) : null
          }
        >
          <Table
            caption={section.title}
            columns={[
              {
                key: 'label',
                header: 'Field',
                width: '14rem',
                cell: (field: AdminField) => field.label,
              },
              {
                key: 'value',
                header: 'Value',
                cell: (field: AdminField) => renderValue(field, row),
              },
            ]}
            rows={section.fields}
            rowKey={(field) => field.name}
            empty="No fields."
          />
        </Card>
      ))}
    </div>
  )
}
