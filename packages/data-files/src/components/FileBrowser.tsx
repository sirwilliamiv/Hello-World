'use client'

/**
 * `exposes: { kind: "component", name: "FileBrowser" }`. Backs the `/files` surface.
 *
 * The list only ever contains files that cleared scanning — the API filters, so a
 * quarantined file is not rendered as "unavailable", it is not rendered at all.
 * Links point at `/api/files/:id`, which redirects to a freshly signed, expiring URL
 * rather than embedding one in the page where it would outlive the session.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { EntityAttachment } from '../types.js'

export interface BrowsableFile {
  id: string
  filename: string
  content_type: string
  size_bytes: number
}

export interface FileBrowserProps {
  /** Narrow the list to one entity's attachments. */
  attachedTo?: EntityAttachment
  emptyMessage?: string
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'B'}`
}

export function FileBrowser(props: FileBrowserProps): ReactElement {
  const [rows, setRows] = useState<BrowsableFile[] | null>(null)
  const [error, setError] = useState<string>('')
  const entity = props.attachedTo?.entity
  const entityId = props.attachedTo?.id

  useEffect(() => {
    const query =
      entity === undefined || entityId === undefined
        ? ''
        : `?entity=${encodeURIComponent(entity)}&id=${encodeURIComponent(entityId)}`
    let cancelled = false
    void fetch(`/api/files${query}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not list files (${res.status})`)
        return (await res.json()) as BrowsableFile[]
      })
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [entity, entityId])

  if (error !== '') return <p className="forge-file-browser__error">{error}</p>
  if (rows === null) return <p className="forge-file-browser__loading">Loading…</p>
  if (rows.length === 0) {
    return <p className="forge-file-browser__empty">{props.emptyMessage ?? 'No files yet.'}</p>
  }

  return (
    <ul className="forge-file-browser">
      {rows.map((row) => (
        <li key={row.id} className="forge-file-browser__item">
          <a href={`/api/files/${row.id}`} rel="noopener">
            {row.filename}
          </a>
          <span className="forge-file-browser__meta">{humanSize(row.size_bytes)}</span>
        </li>
      ))}
    </ul>
  )
}
