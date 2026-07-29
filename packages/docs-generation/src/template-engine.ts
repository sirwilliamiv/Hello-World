/**
 * A small, deliberately boring mustache-shaped template engine.
 *
 * Why not a library: the byte-identical-reissue guarantee is a property of the whole
 * render path, and a template engine is the easiest place to lose it. This one has no
 * clock, no random source, no locale lookup, and no ambient state — the only inputs
 * are the source text, the data, and the helper table. Object iteration is sorted by
 * key, because insertion order would otherwise leak the order a caller happened to
 * build an object in.
 *
 * Syntax:
 *   {{ path.to.value }}          escaped interpolation
 *   {{{ path.to.value }}}        raw interpolation
 *   {{ helper arg 'literal' }}   helper call
 *   {{#if expr}} … {{else}} … {{/if}}
 *   {{#unless expr}} … {{/unless}}
 *   {{#each items}} … {{/each}}  with this, @index, @key, @first, @last
 *   {{! comment }}
 *   ../ to reach the enclosing scope
 */
import { TemplateSyntaxError } from './errors.js'

export type HelperTable = Readonly<Record<string, (...args: readonly unknown[]) => string>>

type Arg =
  | { kind: 'path'; value: string }
  | { kind: 'literal'; value: string | number | boolean | null }

interface Expr {
  /** Helper name, resolved against the table at render time. */
  head: Arg
  args: Arg[]
}

type Node =
  | { type: 'text'; value: string }
  | { type: 'expr'; expr: Expr; escape: boolean }
  | { type: 'block'; kind: 'if' | 'unless' | 'each'; expr: Expr; body: Node[]; alt: Node[] }

export interface CompiledTemplate {
  readonly source: string
  render(data: unknown, helpers: HelperTable): string
}

// ── lexing ──────────────────────────────────────────────────────────────────────

const TAG = /\{\{\{?[^}]*\}?\}\}/g

function parseArgs(text: string): Arg[] {
  const args: Arg[] = []
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const quoted = match[1] ?? match[2]
    if (quoted !== undefined) {
      args.push({ kind: 'literal', value: quoted })
      continue
    }
    const bare = match[3] as string
    if (bare === 'true' || bare === 'false') {
      args.push({ kind: 'literal', value: bare === 'true' })
    } else if (bare === 'null') {
      args.push({ kind: 'literal', value: null })
    } else if (/^-?\d+(\.\d+)?$/.test(bare)) {
      args.push({ kind: 'literal', value: Number(bare) })
    } else {
      args.push({ kind: 'path', value: bare })
    }
  }
  return args
}

function parseExpr(text: string, tag: string): Expr {
  const args = parseArgs(text.trim())
  const head = args.shift()
  if (head === undefined) throw new TemplateSyntaxError(`Empty expression in ${tag}`)
  return { head, args }
}

export function compile(source: string): CompiledTemplate {
  const root: Node[] = []
  const stack: { node: Extract<Node, { type: 'block' }>; inAlt: boolean }[] = []

  const push = (node: Node): void => {
    const top = stack[stack.length - 1]
    if (top === undefined) root.push(node)
    else if (top.inAlt) top.node.alt.push(node)
    else top.node.body.push(node)
  }

  let cursor = 0
  let match: RegExpExecArray | null
  TAG.lastIndex = 0
  while ((match = TAG.exec(source)) !== null) {
    const tag = match[0]
    if (match.index > cursor) push({ type: 'text', value: source.slice(cursor, match.index) })
    cursor = match.index + tag.length

    const raw = tag.startsWith('{{{')
    const inner = raw ? tag.slice(3, -3) : tag.slice(2, -2)
    const trimmed = inner.trim()

    if (trimmed.startsWith('!')) continue // comment

    if (trimmed.startsWith('#')) {
      const [keyword, ...rest] = trimmed.slice(1).trim().split(/\s+/)
      if (keyword !== 'if' && keyword !== 'unless' && keyword !== 'each') {
        throw new TemplateSyntaxError(`Unknown block helper {{#${String(keyword)}}}`)
      }
      const node: Extract<Node, { type: 'block' }> = {
        type: 'block',
        kind: keyword,
        expr: parseExpr(rest.join(' '), tag),
        body: [],
        alt: [],
      }
      push(node)
      stack.push({ node, inAlt: false })
      continue
    }

    if (trimmed === 'else') {
      const top = stack[stack.length - 1]
      if (top === undefined) throw new TemplateSyntaxError('{{else}} outside a block')
      top.inAlt = true
      continue
    }

    if (trimmed.startsWith('/')) {
      const closing = trimmed.slice(1).trim()
      const top = stack.pop()
      if (top === undefined || top.node.kind !== closing) {
        throw new TemplateSyntaxError(
          `{{/${closing}}} does not close the open block${top === undefined ? '' : ` {{#${top.node.kind}}}`}`,
        )
      }
      continue
    }

    push({ type: 'expr', expr: parseExpr(trimmed, tag), escape: !raw })
  }

  if (stack.length > 0) {
    throw new TemplateSyntaxError(`Unclosed block {{#${stack[stack.length - 1]?.node.kind}}}`)
  }
  if (cursor < source.length) push({ type: 'text', value: source.slice(cursor) })

  return { source, render: (data, helpers) => renderNodes(root, [data], helpers, {}) }
}

// ── rendering ───────────────────────────────────────────────────────────────────

type Locals = Record<string, unknown>

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Deterministic value → text. No locale, no clock, no float formatting surprises. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(stringify).join(', ')
  return JSON.stringify(sortDeep(value))
}

/** Recursively key-sorted copy. Used for both stringification and hashing. */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
    return out
  }
  return value
}

function resolvePath(path: string, scopes: readonly unknown[], locals: Locals): unknown {
  if (path.startsWith('@')) return locals[path]

  let depth = 0
  let rest = path
  while (rest.startsWith('../')) {
    depth += 1
    rest = rest.slice(3)
  }
  const scope = scopes[scopes.length - 1 - depth]
  if (rest === '' || rest === 'this' || rest === '.') return scope

  let current: unknown = scope
  for (const segment of rest.split('.')) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function evalArg(arg: Arg, scopes: readonly unknown[], locals: Locals): unknown {
  return arg.kind === 'literal' ? arg.value : resolvePath(arg.value, scopes, locals)
}

function evalExpr(
  expr: Expr,
  scopes: readonly unknown[],
  locals: Locals,
  helpers: HelperTable,
): unknown {
  if (expr.head.kind === 'path') {
    const helper = helpers[expr.head.value]
    if (helper !== undefined) {
      return helper(...expr.args.map((arg) => evalArg(arg, scopes, locals)))
    }
    if (expr.args.length > 0) {
      throw new TemplateSyntaxError(
        `No template helper named '${expr.head.value}'. Registered helpers: ${Object.keys(helpers).sort().join(', ')}`,
      )
    }
  }
  return evalArg(expr.head, scopes, locals)
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

function renderNodes(
  nodes: readonly Node[],
  scopes: readonly unknown[],
  helpers: HelperTable,
  locals: Locals,
): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value
      continue
    }
    if (node.type === 'expr') {
      const text = stringify(evalExpr(node.expr, scopes, locals, helpers))
      out += node.escape ? escapeHtml(text) : text
      continue
    }

    const value = evalExpr(node.expr, scopes, locals, helpers)

    if (node.kind === 'if' || node.kind === 'unless') {
      const take = node.kind === 'if' ? truthy(value) : !truthy(value)
      out += renderNodes(take ? node.body : node.alt, scopes, helpers, locals)
      continue
    }

    // each — arrays in order, objects in sorted key order.
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : value !== null && typeof value === 'object'
        ? Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]])
        : []

    if (entries.length === 0) {
      out += renderNodes(node.alt, scopes, helpers, locals)
      continue
    }

    entries.forEach(([key, item], index) => {
      out += renderNodes([...node.body], [...scopes, item], helpers, {
        ...locals,
        '@index': index,
        '@key': key,
        '@first': index === 0,
        '@last': index === entries.length - 1,
        '@number': index + 1,
      })
    })
  }
  return out
}
