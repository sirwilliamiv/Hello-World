/**
 * Deep redaction, applied to every structure this package emits.
 *
 * The rule is type-driven (see ./secret.ts). Nothing here inspects key names.
 * A field called `password` holding a plain string is emitted verbatim, because
 * the fix for that is to bind it to a declared credential, not to grow a
 * denylist that is wrong on both sides.
 */

import { isSecret, REDACTED } from './secret.js'

const CIRCULAR = '[circular]'
const TRUNCATED = '[truncated]'
const MAX_DEPTH = 8

export interface RedactOptions {
  /** Structures deeper than this collapse to `[truncated]`. */
  readonly maxDepth?: number
}

/**
 * Produce a JSON-safe copy of `value` with every {@link Secret} replaced by
 * `"[redacted]"`, at any depth, including inside arrays, Maps, Sets and Errors.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  return walk(value, maxDepth, 0, new WeakSet<object>())
}

/** Redact a field bag. Always an object, so a log record shape is stable. */
export function redactFields(
  fields: Readonly<Record<string, unknown>> | undefined,
  options: RedactOptions = {},
): Record<string, unknown> {
  if (fields === undefined) return {}
  const out = redact(fields, options)
  return isPlainRecord(out) ? out : { value: out }
}

function walk(
  value: unknown,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  // Checked before anything else: a Secret must never reach a branch that
  // could read its properties.
  if (isSecret(value)) return REDACTED

  if (value === null) return null

  switch (typeof value) {
    case 'undefined':
      return undefined
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return `${value.toString()}n`
    case 'symbol':
      return value.toString()
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
    default:
      break
  }

  const obj = value as object
  if (depth >= maxDepth) return TRUNCATED
  if (seen.has(obj)) return CIRCULAR
  seen.add(obj)

  try {
    if (obj instanceof Date) return obj.toISOString()
    if (obj instanceof RegExp) return obj.source
    if (obj instanceof URL) return obj.toString()
    if (obj instanceof Error) return redactError(obj, maxDepth, depth, seen)

    if (Array.isArray(obj)) {
      return obj.map((item) => walk(item, maxDepth, depth + 1, seen))
    }
    if (obj instanceof Set) {
      return [...obj].map((item) => walk(item, maxDepth, depth + 1, seen))
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of obj) out[String(k)] = walk(v, maxDepth, depth + 1, seen)
      return out
    }

    // A value with its own toJSON (other than a Secret, handled above) is
    // trusted to describe itself, but the description is walked too.
    const maybeJson = obj as { toJSON?: () => unknown }
    if (typeof maybeJson.toJSON === 'function') {
      return walk(maybeJson.toJSON(), maxDepth, depth + 1, seen)
    }

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walk(v, maxDepth, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

export interface RedactedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly cause?: unknown
  readonly [key: string]: unknown
}

function redactError(
  err: Error,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>,
): RedactedError {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  }
  if (err.stack !== undefined) out['stack'] = err.stack
  if (err.cause !== undefined) {
    out['cause'] = walk(err.cause, maxDepth, depth + 1, seen)
  }
  // Own enumerable properties carry the interesting context on custom errors.
  for (const [k, v] of Object.entries(err)) {
    if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause') continue
    out[k] = walk(v, maxDepth, depth + 1, seen)
  }
  return out as RedactedError
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
