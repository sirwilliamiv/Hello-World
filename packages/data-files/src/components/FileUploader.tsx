'use client'

/**
 * `exposes: { kind: "component", name: "FileUploader" }`.
 *
 * The three-step direct-to-storage dance, in one component:
 *   1. POST /api/files            → a signed grant
 *   2. PUT  <grant.url>           → bytes go to storage, not through the app
 *   3. POST /api/files/sessions/:id/complete → hand off to the scanner
 *
 * Step 3 does not make the file available. It becomes available when the scan
 * clears, which is why `onUploaded` reports `status: 'scanning'` and the UI says
 * "scanning" rather than pretending the file is ready.
 */
import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import type { EntityAttachment, UploadSession } from '../types.js'

export interface FileUploaderProps {
  /** Entity the upload hangs off, so cascade delete can find it later. */
  attachedTo?: EntityAttachment
  /** `accept` for the file input; the server re-checks against configuration. */
  accept?: string
  onUploaded?: (result: { fileId: string; status: string }) => void
  onError?: (message: string) => void
}

type Phase = 'idle' | 'requesting' | 'transferring' | 'scanning' | 'error'

export function FileUploader(props: FileUploaderProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string>('')

  const send = useCallback(
    async (file: File): Promise<void> => {
      try {
        setPhase('requesting')
        const grantRes = await fetch('/api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
            ...(props.attachedTo === undefined ? {} : { attachedTo: props.attachedTo }),
          }),
        })
        if (!grantRes.ok) throw new Error((await grantRes.json()).message ?? 'Upload was refused')
        const session = (await grantRes.json()) as UploadSession

        setPhase('transferring')
        const put = await fetch(session.url, {
          method: session.method,
          headers: session.headers,
          body: file,
        })
        if (!put.ok) throw new Error(`Storage rejected the upload (${put.status})`)

        setPhase('scanning')
        const done = await fetch(`/api/files/sessions/${session.id}/complete`, { method: 'POST' })
        if (!done.ok) throw new Error((await done.json()).message ?? 'Upload could not be confirmed')
        const result = (await done.json()) as { id: string; status: string }

        setMessage('Uploaded. It will appear once it has been scanned.')
        props.onUploaded?.({ fileId: result.id, status: result.status })
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        setPhase('error')
        setMessage(text)
        props.onError?.(text)
      }
    },
    [props],
  )

  return (
    <div className="forge-file-uploader" data-phase={phase}>
      <input
        type="file"
        {...(props.accept === undefined ? {} : { accept: props.accept })}
        disabled={phase === 'requesting' || phase === 'transferring'}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) void send(file)
        }}
      />
      {message !== '' ? <p className="forge-file-uploader__message">{message}</p> : null}
    </div>
  )
}
