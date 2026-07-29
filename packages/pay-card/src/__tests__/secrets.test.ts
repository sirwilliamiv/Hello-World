import { describe, expect, it, vi } from 'vitest'
import { Money } from '@forge/kernel-money'
import * as payCard from '../index.js'
import { charge } from '../charge.js'
import { stripeWebhookHandler } from '../webhook.js'
import {
  TEST_SECRET_KEY,
  TEST_WEBHOOK_SECRET,
  bus,
  misSignedWebhookRequest,
  paymentIntentSucceededEvent,
  setupPayments,
  signedWebhookRequest,
} from '../testing/harness.js'
import { SQL } from '../db/postgres.js'

/**
 * ARCHITECTURE.md section 9.4: secrets arrive from the validated environment
 * schema, are used, and go no further. They are never logged, never persisted,
 * and never placed in an event payload.
 */

function containsSecret(value: string): boolean {
  return value.includes(TEST_SECRET_KEY) || value.includes(TEST_WEBHOOK_SECRET)
}

describe('secret handling', () => {
  it('does not expose the secret key or webhook secret from the package surface', () => {
    const serialised = JSON.stringify(
      Object.fromEntries(
        Object.entries(payCard).map(([k, v]) => [k, typeof v === 'function' ? 'fn' : v]),
      ),
    )
    expect(containsSecret(serialised)).toBe(false)
    expect(Object.keys(payCard)).not.toContain('secretKey')
    expect(Object.keys(payCard)).not.toContain('webhookSecret')
  })

  it('never writes a secret into an event payload', async () => {
    setupPayments()
    await charge(Money.of(999, 'USD'), { id: 'user_1' }, { invoiceId: 'inv_1' })
    expect(containsSecret(JSON.stringify(bus.published()))).toBe(false)
  })

  it('never writes a secret into a persisted row', async () => {
    const h = setupPayments()
    await charge(Money.of(999, 'USD'), { id: 'user_1' })
    await stripeWebhookHandler(signedWebhookRequest(h.stripe, paymentIntentSucceededEvent()))
    expect(containsSecret(JSON.stringify(h.store.state))).toBe(false)
  })

  it('never logs a secret, including on a verification failure', async () => {
    const h = setupPayments()
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      }),
    )

    await stripeWebhookHandler(misSignedWebhookRequest(paymentIntentSucceededEvent()))
    await charge(Money.of(100, 'USD'), { id: 'user_1' })
    await stripeWebhookHandler(signedWebhookRequest(h.stripe, paymentIntentSucceededEvent()))

    for (const spy of spies) spy.mockRestore()
    expect(lines.filter(containsSecret)).toEqual([])
  })

  it('has no SQL statement that could persist a credential', () => {
    const statements = Object.values(SQL).join('\n').toLowerCase()
    expect(statements).not.toMatch(/secret/)
    expect(statements).not.toMatch(/api_key/)
  })
})
