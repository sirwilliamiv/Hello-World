/**
 * Test double for react/jsx-runtime.
 *
 * Returns a plain `{ type, props }` tree so a component can be asserted on
 * without React or a DOM. That is all the "PaymentForm renders no card input"
 * test needs.
 */

export interface TestElement {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly key: string | null
}

function element(type: unknown, props: Record<string, unknown>, key?: unknown): TestElement {
  return { type, props, key: key === undefined ? null : String(key) }
}

export const jsx = element
export const jsxs = element
export const jsxDEV = element
export const Fragment = Symbol.for('react.fragment')

/** Depth-first walk over a rendered tree, including children. */
export function walk(node: unknown, visit: (n: TestElement) => void): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const el = node as TestElement
  if (!('props' in el)) return
  visit(el)
  walk(el.props['children'], visit)
}
