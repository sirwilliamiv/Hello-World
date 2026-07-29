import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { PaymentForm, PAYMENT_ELEMENT_MOUNT_ID } from '../PaymentForm.js'
import { walk, type TestElement } from '../testing/doubles/jsx-runtime.js'
import { isForbiddenFieldName } from '../card-data-guard.js'

/**
 * The UI half of "card data never touches our database": if the form rendered a
 * React-controlled card input, the number would reach our server on submit. It
 * must not, so the tree is asserted to contain no input at all.
 */

function render(): TestElement[] {
  const tree = PaymentForm({
    amount: Money.of(4999, 'USD'),
    customerId: 'user_1',
    clientSecret: 'pi_test_1_secret_abc',
    publishableKey: 'pk_test_forge',
  }) as unknown as TestElement

  const nodes: TestElement[] = []
  walk(tree, (n) => nodes.push(n))
  return nodes
}

describe('PaymentForm', () => {
  it('renders no input capable of receiving card data', () => {
    const nodes = render()
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.filter((n) => n.type === 'input')).toEqual([])
    expect(nodes.filter((n) => n.type === 'textarea')).toEqual([])
  })

  it('has no prop whose name suggests card data', () => {
    for (const node of render()) {
      for (const key of Object.keys(node.props)) {
        expect(isForbiddenFieldName(key)).toBe(false)
      }
    }
  })

  it('provides the mount point Stripe Elements attaches its iframe to', () => {
    const nodes = render()
    const mount = nodes.find((n) => n.props['id'] === PAYMENT_ELEMENT_MOUNT_ID)
    expect(mount).toBeDefined()
  })

  it('never receives the secret key — only the publishable key and a client secret', () => {
    const nodes = render()
    const serialised = JSON.stringify(nodes.map((n) => n.props))
    expect(serialised).not.toMatch(/sk_/)
    expect(serialised).not.toMatch(/whsec_/)
    expect(serialised).toMatch(/pk_test_forge/)
  })
})
