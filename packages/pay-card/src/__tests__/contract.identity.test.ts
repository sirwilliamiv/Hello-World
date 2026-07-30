import { describe, expect, it } from 'vitest'
import { detachOnUserDeleted } from '../payment-methods.js'
import { attachPaymentMethod, listPaymentMethods } from '../payment-methods.js'
import { setupPayments } from '../testing/harness.js'
import { loadCapability } from '../testing/json-schema.js'

/**
 * Mandatory contract test with kernel.identity:
 * "a user is deleted while holding a stored payment method → the payment method
 *  is detached at the provider and the local record is removed".
 */

describe('contract: pay.card × kernel.identity', () => {
  it('detaches at the provider and removes the local record', async () => {
    const h = setupPayments()

    await attachPaymentMethod({
      customerId: 'user_7',
      providerRef: 'pm_1NxUserSeven',
      providerCustomerId: 'cus_7',
    })
    expect(await listPaymentMethods('user_7')).toHaveLength(1)

    await detachOnUserDeleted({
      name: 'identity.user.deleted',
      payload: { user_id: 'user_7', reason: 'account closed' },
    })

    expect(h.stripe.detachedPaymentMethods).toEqual(['pm_1NxUserSeven'])
    expect(await listPaymentMethods('user_7')).toHaveLength(0)
    expect(h.store.state.paymentMethods).toHaveLength(0)
  })

  it('leaves other users untouched', async () => {
    const h = setupPayments()
    await attachPaymentMethod({ customerId: 'user_a', providerRef: 'pm_A', providerCustomerId: 'cus_a' })
    await attachPaymentMethod({ customerId: 'user_b', providerRef: 'pm_B', providerCustomerId: 'cus_b' })

    await detachOnUserDeleted({ name: 'identity.user.deleted', payload: { user_id: 'user_a' } })

    expect(h.stripe.detachedPaymentMethods).toEqual(['pm_A'])
    expect(h.store.state.paymentMethods.map((p) => p.customerId)).toEqual(['user_b'])
  })

  it('is a no-op for a user with no stored payment method', async () => {
    const h = setupPayments()
    await detachOnUserDeleted({ name: 'identity.user.deleted', payload: { user_id: 'ghost' } })
    expect(h.stripe.detachedPaymentMethods).toEqual([])
  })

  it('is the handler name the capability specification declares', () => {
    const spec = loadCapability('catalog/pay/pay.card.capability.json')
    const consumes = spec['consumes'] as { name: string; handler: string; required: boolean }[]
    const declared = consumes.find((c) => c.name === 'identity.user.deleted')
    expect(declared?.handler).toBe('detachOnUserDeleted')
    expect(declared?.required).toBe(true)
  })
})
