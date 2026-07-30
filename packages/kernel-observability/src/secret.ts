/**
 * Secret<T> — the redaction primitive.
 *
 * ARCHITECTURE §9.4: "Provider inputs are redacted in plan output by type, not
 * by pattern-matching on key names." The same rule governs the runtime: a value
 * bound to a declared credential name is wrapped in `Secret` at the boundary
 * where it enters the process, and every serialiser in this package refuses to
 * emit its contents.
 *
 * Pattern-matching on key names ("anything called *_key or *token") fails in
 * both directions: it redacts `public_key` and it misses `sk`. Carrying the
 * sensitivity in the type means the only way to log a secret is to call
 * `.expose()`, which is greppable in review.
 */

/**
 * Registered on the global symbol registry deliberately. Two copies of this
 * package in one process (a plausible outcome of a workspace + published-registry
 * transition, §14.3) must still recognise each other's secrets, or redaction
 * silently stops working at exactly the moment the dependency tree changes.
 */
const SECRET_BRAND: unique symbol = Symbol.for(
  '@forge/kernel-observability:Secret',
) as unknown as typeof SECRET_BRAND

/** The single string that ever stands in for a secret value. */
export const REDACTED = '[redacted]' as const

const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * An opaque wrapper around a sensitive value.
 *
 * Every conversion path a value can take on its way into a log line —
 * `JSON.stringify`, template literals, `String()`, `util.inspect`, implicit
 * coercion — is overridden to produce {@link REDACTED}.
 */
export class Secret<T> {
  /** Brand, checked by {@link isSecret}. Not enumerable, so it never serialises. */
  readonly [SECRET_BRAND] = true as const

  /** The declared credential name this value is bound to, when there is one. */
  readonly name: string | undefined

  #value: T

  constructor(value: T, name?: string) {
    this.#value = value
    this.name = name
    // Non-enumerable so that a structured clone or a spread of this object
    // cannot carry the brand without the class, and so the brand itself never
    // appears in output.
    Object.defineProperty(this, SECRET_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
    })
  }

  /**
   * Unwrap. The only way to read the value, and the only thing to look for in
   * review when asking "can this leak?".
   */
  expose(): T {
    return this.#value
  }

  /** Derive a new secret without ever widening the unwrapped value's scope. */
  map<U>(fn: (value: T) => U): Secret<U> {
    return new Secret<U>(fn(this.#value), this.name)
  }

  /** Constant-time-ish equality that never returns the value. */
  equals(other: Secret<T>): boolean {
    return other.expose() === this.#value
  }

  toJSON(): string {
    return REDACTED
  }

  toString(): string {
    return REDACTED
  }

  valueOf(): string {
    return REDACTED
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }

  [NODE_INSPECT](): string {
    return REDACTED
  }

  get [Symbol.toStringTag](): string {
    return this.name === undefined ? 'Secret' : `Secret(${this.name})`
  }
}

/** Wrap a value so it can never be logged. */
export function secret<T>(value: T, name?: string): Secret<T> {
  return name === undefined ? new Secret(value) : new Secret(value, name)
}

/**
 * Type guard. Brand-based rather than `instanceof`, so it survives duplicated
 * copies of this package in the module graph.
 */
export function isSecret(value: unknown): value is Secret<unknown> {
  if (typeof value !== 'object' || value === null) return false
  return (value as Record<PropertyKey, unknown>)[SECRET_BRAND] === true
}

/** Unwrap if secret, pass through otherwise. */
export function exposeIfSecret(value: unknown): unknown {
  return isSecret(value) ? value.expose() : value
}

export interface CredentialSource {
  readonly [key: string]: string | undefined
}

export class MissingCredentialError extends Error {
  readonly credential: string

  constructor(name: string) {
    super(
      `Credential ${name} is declared but not present in the environment. ` +
        `Forge generates the environment variable schema, never the values — ` +
        `set ${name} in the secrets provider for this workspace.`,
    )
    this.name = 'MissingCredentialError'
    this.credential = name
  }
}

/**
 * Bind a declared credential name to its environment value, as a Secret.
 *
 * This is the boundary the redaction guarantee rests on: `src/generated/env.ts`
 * validates that the variable is present, and everything downstream reads it
 * through here so it is a `Secret<string>` from its first assignment onward.
 */
export function credential(
  name: string,
  source: CredentialSource = process.env as CredentialSource,
): Secret<string> {
  const value = source[name]
  if (value === undefined || value === '') throw new MissingCredentialError(name)
  return new Secret(value, name)
}

/** As {@link credential}, but for a credential declared `optional: true`. */
export function optionalCredential(
  name: string,
  source: CredentialSource = process.env as CredentialSource,
): Secret<string> | undefined {
  const value = source[name]
  if (value === undefined || value === '') return undefined
  return new Secret(value, name)
}

/**
 * Bind every declared credential name in one call. Intended to be handed the
 * credential list the resolved graph produced.
 */
export function bindCredentials(
  names: readonly string[],
  source: CredentialSource = process.env as CredentialSource,
): Record<string, Secret<string>> {
  const bound: Record<string, Secret<string>> = {}
  for (const name of names) bound[name] = credential(name, source)
  return bound
}
