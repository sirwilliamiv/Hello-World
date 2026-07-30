'use client'

/**
 * `exposes: { kind: "component", name: "TemplateEditor" }`. Backs the
 * `/admin/templates` surface.
 *
 * The editor takes its actions as props rather than calling an API of its own,
 * because `docs.generation` declares no route in its specification — the admin
 * surface supplies server actions. See the report.
 *
 * The UI states the append-only rule plainly, because it is the one thing an admin
 * needs to understand about this screen: saving does not edit the template, it
 * publishes a new version, and documents already issued keep the version they used.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { TemplateVersion } from '../types.js'

export interface TemplateEditorProps {
  templateKey: string
  templateName: string
  /** Newest last. Rendered as the version history. */
  versions: readonly Pick<TemplateVersion, 'version' | 'createdAt' | 'sourceHash'>[]
  /** The source of the version being edited, usually the current one. */
  initialSource: string
  /** Publishes a new version. Never overwrites the one shown. */
  onPublish(source: string): Promise<void>
  /** Renders the draft against sample data and returns HTML. */
  onPreview?(source: string): Promise<string>
}

export function TemplateEditor(props: TemplateEditorProps): ReactElement {
  const [source, setSource] = useState(props.initialSource)
  const [preview, setPreview] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const publish = async (): Promise<void> => {
    setBusy(true)
    setStatus('')
    try {
      await props.onPublish(source)
      setStatus(`Published version ${props.versions.length + 1}. Existing documents are unchanged.`)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    if (props.onPreview === undefined) return
    setBusy(true)
    try {
      setPreview(await props.onPreview(source))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="forge-template-editor">
      <header>
        <h2>{props.templateName}</h2>
        <p className="forge-template-editor__note">
          Saving publishes a new version. Documents already issued keep the version they were
          rendered with, so reissuing one is byte-identical to the original.
        </p>
      </header>

      <textarea
        className="forge-template-editor__source"
        value={source}
        spellCheck={false}
        rows={24}
        onChange={(event) => setSource(event.target.value)}
      />

      <div className="forge-template-editor__actions">
        <button type="button" onClick={() => void publish()} disabled={busy}>
          Publish new version
        </button>
        {props.onPreview === undefined ? null : (
          <button type="button" onClick={() => void runPreview()} disabled={busy}>
            Preview
          </button>
        )}
      </div>

      {status === '' ? null : <p className="forge-template-editor__status">{status}</p>}

      <ol className="forge-template-editor__versions">
        {props.versions.map((version) => (
          <li key={version.version}>
            <strong>v{version.version}</strong>
            <span> {new Date(version.createdAt).toISOString().slice(0, 10)}</span>
            <code>{version.sourceHash.slice(0, 12)}</code>
          </li>
        ))}
      </ol>

      {preview === '' ? null : (
        <iframe
          className="forge-template-editor__preview"
          title="Template preview"
          srcDoc={preview}
        />
      )}
    </section>
  )
}
