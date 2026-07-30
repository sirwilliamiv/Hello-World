/**
 * Walking a rendered React tree without a DOM.
 *
 * This is a test *utility*, not a stand-in for React: `InvoiceList` is rendered by
 * the real `react/jsx-runtime`, and the elements walked here are real React
 * elements. It exists because the component is presentational — the assertions are
 * about which elements it emits and what it put in their props — and mounting a DOM
 * to answer that would test react-dom rather than the component.
 */

/** The slice of a React element these tests read. */
export interface RenderedElement {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly key: string | null
}

function isElement(node: unknown): node is RenderedElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node
}

/** Depth-first walk over a rendered tree, including children. */
export function walk(node: unknown, visit: (element: RenderedElement) => void): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  walk(node.props['children'], visit)
}

/** Every element in the tree, in document order. */
export function elements(tree: unknown): RenderedElement[] {
  const out: RenderedElement[] = []
  walk(tree, (element) => out.push(element))
  return out
}
