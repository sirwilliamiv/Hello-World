/**
 * The registry primitive.
 *
 * ARCHITECTURE §9.3: a capability declares
 * `registers: [{ registry: "kernel.ui:navigation", entries: [...] }]` and the
 * target declares a matching `exposes` entry of kind `registry`. On the runtime
 * side that becomes an in-process registry populated at module-evaluation time
 * by generated wiring, which is why `owns` lists `NavigationEntry` and
 * `SurfaceRegistration` with `kind: "registry"`.
 *
 * Registration is idempotent on the key. A generated module evaluated twice
 * (Next.js dev server, two runtimes) must not produce duplicate nav items.
 */

export interface Registry<T> {
  /** Add or replace an entry. Returns an unregister function. */
  register(entry: T): () => void
  /** Every entry, in registration order unless the registry sorts. */
  all(): readonly T[]
  get(key: string): T | undefined
  has(key: string): boolean
  unregister(key: string): void
  clear(): void
  readonly size: number
}

export interface RegistryOptions<T> {
  readonly name: string
  readonly key: (entry: T) => string
  /** Applied to `all()`. Determinism matters here for the same reason it does in §10. */
  readonly sort?: (a: T, b: T) => number
}

export function createRegistry<T>(options: RegistryOptions<T>): Registry<T> {
  const entries = new Map<string, T>()

  return {
    register(entry: T): () => void {
      const key = options.key(entry)
      entries.set(key, entry)
      return () => {
        if (entries.get(key) === entry) entries.delete(key)
      }
    },
    all(): readonly T[] {
      const values = [...entries.values()]
      return options.sort === undefined ? values : values.sort(options.sort)
    },
    get(key: string): T | undefined {
      return entries.get(key)
    },
    has(key: string): boolean {
      return entries.has(key)
    },
    unregister(key: string): void {
      entries.delete(key)
    },
    clear(): void {
      entries.clear()
    },
    get size(): number {
      return entries.size
    },
  }
}
