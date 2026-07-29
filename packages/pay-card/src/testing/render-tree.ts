import type { ReactElement } from 'react'

/**
 * A depth-first walk over a React element tree.
 *
 * `PaymentForm` is asserted structurally — "there is no input in this tree that
 * could receive a card number" — and that assertion only means something if the
 * tree is the one React actually builds. So this walks real elements produced by
 * `react/jsx-runtime`; it is a traversal helper, not a stand-in for React.
 *
 * No DOM and no renderer is involved on purpose: `PaymentForm` is a plain
 * function component with no hooks, so calling it returns the element tree
 * directly, and the invariant under test is about what is in that tree.
 */
export type RenderedNode = ReactElement<Record<string, unknown>>

function isElement(node: unknown): node is RenderedNode {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

export function walk(node: unknown, visit: (n: RenderedNode) => void): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  walk(node.props['children'], visit)
}
