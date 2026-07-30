'use client'

import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react'

/**
 * The `AccountSettings` UI surface declared in `exposes`.
 *
 * Deliberately unstyled: kernel.ui owns the design tokens and capabilities
 * never ship their own styles (see templates/kernel.ui/tokens.css.tmpl). Class
 * names are hooks for those tokens, nothing more.
 */

export interface AccountSettingsProps {
  /** Mount point of the auth route. Must match `configureIdentity({ basePath })`. */
  basePath?: string
}

interface SessionSummary {
  id: string
  created_at: string
  expires_at: string
  revoked: boolean
  current: boolean
  ip: string | null
  user_agent: string | null
}

interface SessionResponse {
  authenticated: boolean
  user?: { id: string; email: string; name: string | null; email_verified: boolean }
}

export function AccountSettings({ basePath = '/auth' }: AccountSettingsProps): JSX.Element {
  const [account, setAccount] = useState<SessionResponse | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [me, mine] = await Promise.all([
      fetch(`${basePath}/session`).then((r) => r.json() as Promise<SessionResponse>),
      fetch(`${basePath}/sessions`).then((r) =>
        r.ok ? (r.json() as Promise<{ sessions: SessionSummary[] }>) : { sessions: [] },
      ),
    ])
    setAccount(me)
    setSessions(mine.sessions)
  }, [basePath])

  useEffect(() => {
    void load()
  }, [load])

  const changePassword = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const response = await fetch(`${basePath}/password/change`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          current_password: form.get('current_password'),
          new_password: form.get('new_password'),
        }),
      })
      const body = (await response.json()) as { message?: string }
      setMessage(response.ok ? 'Password changed.' : (body.message ?? 'Could not change password.'))
      if (response.ok) await load()
    },
    [basePath, load],
  )

  const signOut = useCallback(async () => {
    await fetch(`${basePath}/logout`, { method: 'POST' })
    await load()
  }, [basePath, load])

  if (account === null) return <section className="forge-account">Loading…</section>
  if (!account.authenticated) return <section className="forge-account">Not signed in.</section>

  return (
    <section className="forge-account">
      <h2>Account</h2>
      <dl>
        <dt>Email</dt>
        <dd>
          {account.user?.email}
          {account.user?.email_verified === false ? ' (unverified)' : null}
        </dd>
        <dt>Name</dt>
        <dd>{account.user?.name ?? '—'}</dd>
      </dl>

      <h3>Change password</h3>
      <form onSubmit={changePassword}>
        <label>
          Current password
          <input type="password" name="current_password" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" name="new_password" autoComplete="new-password" required />
        </label>
        <button type="submit">Change password</button>
      </form>
      {message !== null ? <p role="status">{message}</p> : null}

      <h3>Sessions</h3>
      <ul>
        {sessions
          .filter((session) => !session.revoked)
          .map((session) => (
            <li key={session.id}>
              {session.ip ?? 'unknown address'} — started{' '}
              {new Date(session.created_at).toLocaleString()}
              {session.current ? ' (this device)' : null}
            </li>
          ))}
      </ul>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </section>
  )
}
