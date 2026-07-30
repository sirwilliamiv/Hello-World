/**
 * The DataGrid query model — the search/filter/sort/page logic kernel.admin
 * reuses server-side, so it is tested independently of any rendering.
 */

import { describe, expect, it } from 'vitest'

import {
  applyQuery,
  defaultQuery,
  stringify,
  toCsv,
  toggleSort,
  type DataGridColumn,
  type DataGridQuery,
} from '../components/datagrid-model.js'

interface Site {
  id: string
  name: string
  status: string
  visits: number
  opened: Date
}

const rows: Site[] = [
  { id: '1', name: 'Riverside', status: 'active', visits: 12, opened: new Date('2026-01-02') },
  { id: '2', name: 'Highfield', status: 'paused', visits: 3, opened: new Date('2026-03-04') },
  { id: '3', name: 'Riverbank', status: 'active', visits: 30, opened: new Date('2025-11-30') },
]

const columns: DataGridColumn<Site>[] = [
  { key: 'name', header: 'Name' },
  {
    key: 'status',
    header: 'Status',
    filterOptions: [
      { value: 'active', label: 'Active' },
      { value: 'paused', label: 'Paused' },
    ],
  },
  { key: 'visits', header: 'Visits', numeric: true },
  { key: 'opened', header: 'Opened' },
]

function query(overrides: Partial<DataGridQuery> = {}): DataGridQuery {
  return { ...defaultQuery, ...overrides }
}

describe('applyQuery', () => {
  it('returns everything for the default query', () => {
    const page = applyQuery(rows, columns, query())
    expect(page.total).toBe(3)
    expect(page.pageCount).toBe(1)
  })

  it('searches case-insensitively across searchable columns', () => {
    expect(applyQuery(rows, columns, query({ search: 'river' })).total).toBe(2)
    expect(applyQuery(rows, columns, query({ search: 'RIVERSIDE' })).total).toBe(1)
  })

  it('does not search columns presented as filters', () => {
    // 'active' is a filter value, not free text: matching it in search would
    // make the two controls fight.
    expect(applyQuery(rows, columns, query({ search: 'active' })).total).toBe(0)
  })

  it('filters on exact value and ignores an empty selection', () => {
    expect(applyQuery(rows, columns, query({ filters: { status: 'active' } })).total).toBe(2)
    expect(applyQuery(rows, columns, query({ filters: { status: '' } })).total).toBe(3)
  })

  it('combines filter and search', () => {
    const page = applyQuery(
      rows,
      columns,
      query({ filters: { status: 'active' }, search: 'riverb' }),
    )
    expect(page.rows.map((r) => r.id)).toEqual(['3'])
  })

  it('sorts numerically, not lexically', () => {
    const page = applyQuery(rows, columns, query({ sort: { key: 'visits', direction: 'asc' } }))
    expect(page.rows.map((r) => r.visits)).toEqual([3, 12, 30])
  })

  it('sorts dates chronologically', () => {
    const page = applyQuery(rows, columns, query({ sort: { key: 'opened', direction: 'desc' } }))
    expect(page.rows.map((r) => r.id)).toEqual(['2', '1', '3'])
  })

  it('is stable for equal keys', () => {
    const page = applyQuery(rows, columns, query({ sort: { key: 'status', direction: 'asc' } }))
    expect(page.rows.map((r) => r.id)).toEqual(['1', '3', '2'])
  })

  it('paginates and clamps an out-of-range page', () => {
    const page = applyQuery(rows, columns, query({ pageSize: 2, page: 9 }))
    expect(page.pageCount).toBe(2)
    expect(page.page).toBe(2)
    expect(page.rows).toHaveLength(1)
  })

  it('never mutates the input', () => {
    const before = rows.map((r) => r.id)
    applyQuery(rows, columns, query({ sort: { key: 'visits', direction: 'desc' } }))
    expect(rows.map((r) => r.id)).toEqual(before)
  })
})

describe('toggleSort', () => {
  it('cycles asc, desc, off', () => {
    let sort = toggleSort(undefined, 'name')
    expect(sort).toEqual({ key: 'name', direction: 'asc' })
    sort = toggleSort(sort, 'name')
    expect(sort).toEqual({ key: 'name', direction: 'desc' })
    expect(toggleSort(sort, 'name')).toBeUndefined()
  })

  it('restarts at asc on a different column', () => {
    expect(toggleSort({ key: 'name', direction: 'desc' }, 'visits')).toEqual({
      key: 'visits',
      direction: 'asc',
    })
  })
})

describe('toCsv', () => {
  it('emits a header row and CRLF line endings', () => {
    const csv = toCsv(rows.slice(0, 1), columns)
    expect(csv.split('\r\n')[0]).toBe('name,status,visits,opened')
    expect(csv.split('\r\n')[1]).toContain('Riverside,active,12,')
  })

  it('escapes quotes, commas and newlines', () => {
    const csv = toCsv([{ ...rows[0]!, name: 'A "big", site\nhere' }], columns)
    expect(csv).toContain('"A ""big"", site\nhere"')
  })
})

describe('stringify', () => {
  it('renders nullish as empty and dates as ISO', () => {
    expect(stringify(null)).toBe('')
    expect(stringify(undefined)).toBe('')
    expect(stringify(new Date('2026-07-15T00:00:00.000Z'))).toBe('2026-07-15T00:00:00.000Z')
    expect(stringify(0)).toBe('0')
    expect(stringify(false)).toBe('false')
  })
})
