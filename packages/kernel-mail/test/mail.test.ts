import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@forge/kernel-events', () => ({
  publish: vi.fn(async () => {}),
  subscribe: vi.fn(),
}))

import { drainWork, listJobs, resetWorkBackend, stopWork } from '@forge/kernel-work'
import {
  DELIVER_JOB,
  MemoryMailTransport,
  configureMail,
  deleteMessages,
  exportMessages,
  outboundMessages,
  resetMail,
  resetMailDirectory,
  send,
  sendPasswordReset,
  sendVerification,
  setMailDirectory,
} from '../src/index.js'

function setup(): MemoryMailTransport {
  const transport = new MemoryMailTransport()
  configureMail({ dsn: 'memory://', from: 'no-reply@acme.test', transport, appUrl: 'https://acme.test' })
  return transport
}

afterEach(async () => {
  await stopWork()
  resetWorkBackend()
  resetMailDirectory()
  resetMail()
})

describe('kernel.mail', () => {
  it('dispatches exactly one verification message when a user is created', async () => {
    const transport = setup()

    await sendVerification({
      name: 'identity.user.created',
      payload: { user_id: 'u_1', email: 'ada@acme.test', token: 'tok_1' },
    })

    // Delivery is asynchronous: the message is queued, not sent, on return.
    expect(transport.sent).toHaveLength(0)
    expect(listJobs().filter((job) => job.kind === DELIVER_JOB)).toHaveLength(1)

    await drainWork()

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.to).toBe('ada@acme.test')
    expect(transport.sent[0]?.text).toContain('https://acme.test/auth/verify?token=tok_1')
  })

  it('does not send a second verification for the same user', async () => {
    const transport = setup()
    const event = {
      name: 'identity.user.created',
      payload: { user_id: 'u_1', email: 'ada@acme.test', token: 'tok_1' },
    }

    await sendVerification(event)
    await sendVerification(event)
    await drainWork()

    expect(transport.sent).toHaveLength(1)
  })

  it('does not retain the body after delivery', async () => {
    setup()
    await sendVerification({
      payload: { user_id: 'u_1', email: 'ada@acme.test', token: 'tok_1' },
    })
    await drainWork()

    const [message] = await outboundMessages()
    expect(message?.status).toBe('sent')
    expect(message?.text).toBeNull()
  })

  it('sends a password reset using a directory when the contract carries no address', async () => {
    const transport = setup()
    setMailDirectory({
      async address() {
        return 'ada@acme.test'
      },
      async resetLink() {
        return 'https://acme.test/auth/reset?token=tok_2'
      },
    })

    await sendPasswordReset({ payload: { user_id: 'u_1' } })
    await drainWork()

    expect(transport.sent[0]?.to).toBe('ada@acme.test')
    expect(transport.sent[0]?.text).toContain('tok_2')
  })

  it('refuses to send a reset it cannot address, naming the missing piece', async () => {
    setup()
    await expect(sendPasswordReset({ payload: { user_id: 'u_1' } })).rejects.toThrow(
      /no email address/,
    )
  })

  it('rejects an event that does not match the contract', async () => {
    setup()
    await expect(sendVerification({ payload: { user_id: 'u_1' } })).rejects.toThrow()
  })

  it('exports and deletes the messages held about a data subject', async () => {
    setup()
    await send({
      to: 'ada@acme.test',
      subject: 'hello',
      text: 'hi',
      subjectUserId: 'u_1',
    })
    await drainWork()

    const exported = await exportMessages('u_1')
    expect(exported).toHaveLength(1)
    expect(exported[0]?.to).toBe('ada@acme.test')

    expect(await deleteMessages('u_1')).toBe(1)
    expect(await exportMessages('u_1')).toHaveLength(0)
  })

  it('refuses an SMTP DSN rather than pretending to send', () => {
    expect(() => configureMail({ dsn: 'smtp://mail.acme.test:587' })).toThrow(
      /no SMTP client/,
    )
  })
})
