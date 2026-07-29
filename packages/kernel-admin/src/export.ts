/**
 * Export.
 *
 * Spec: "Auto-generated CRUD, search, filter, and export for every registered
 * entity", gated on the separately-registered `admin.export` permission —
 * separate because bulk extraction of an entity flagged `personal_data` is a
 * materially different act from viewing one record, and the two should be
 * grantable independently.
 */

// React-free entry point; see the note in registries.ts.
import { stringify } from '@forge/kernel-ui/data'

import type { AdminListView } from './resolve.js'
import type { Row } from './ports/repository.js'

/** RFC 4180. Rows are already redacted by whatever produced them. */
export function toCsv(rows: readonly Row[], fields: readonly string[]): string {
  const escape = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value

  const header = fields.map(escape).join(',')
  const body = rows.map((row) => fields.map((f) => escape(stringify(row[f]))).join(','))
  return [header, ...body].join('\r\n')
}

export interface ExportOptions {
  /** Defaults to the view's `exportFields`. */
  readonly fields?: readonly string[]
  /** Defaults to `<entity>.csv`. */
  readonly filename?: string
}

/** A CSV download response for an entity list. */
export function exportResponse(
  view: AdminListView,
  rows: readonly Row[],
  options: ExportOptions = {},
): Response {
  const fields = options.fields ?? view.exportFields
  const filename = options.filename ?? `${view.entity}.csv`

  return new Response(toCsv(rows, fields), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
