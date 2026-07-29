/**
 * The single seam between kernel.identity and the two kernel capabilities it
 * builds on: @forge/kernel-data (persistence) and @forge/kernel-events (the
 * bus). Every query in this package goes through `repository()`, which is what
 * makes tenant scoping a repository-layer concern rather than a convention
 * (ARCHITECTURE.md §14.2).
 *
 * The default binding is resolved lazily so that a test — or a client that
 * wants to drive this package against its own data layer — can call
 * `setIdentityRuntime()` first and never load the real packages.
 */

/** Column predicate accepted by the repository. All fields are ANDed. */
export type Where<T> = { [K in keyof T]?: T[K] }

/** Fields the data layer assigns; a caller never supplies them. */
export type New<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

/**
 * The subset of `Repository<T>` from @forge/kernel-data that this capability
 * uses. Declared structurally so a signature drift in kernel.data is a compile
 * error in exactly one file.
 */
export interface RepositoryApi<T> {
  find(where: Where<T>): Promise<T | null>
  findMany(where?: Where<T>): Promise<T[]>
  create(values: New<T>): Promise<T>
  update(id: string, values: Partial<New<T>>): Promise<T>
  softDelete(id: string): Promise<void>
  restore(id: string): Promise<void>
}

export interface IdentityRuntime {
  repository: <T>(entity: string) => RepositoryApi<T>
  publish: (name: string, payload: Record<string, unknown>) => Promise<void>
  /** Injectable clock; every expiry in this package is computed from it. */
  now: () => Date
}

let installed: IdentityRuntime | null = null
let bound: Promise<IdentityRuntime> | null = null

/** Install a runtime explicitly. Used by tests and by non-default host wiring. */
export function setIdentityRuntime(runtime: IdentityRuntime): void {
  installed = runtime
  bound = null
}

/** Drop an explicitly installed runtime, restoring the lazy kernel binding. */
export function resetIdentityRuntime(): void {
  installed = null
  bound = null
}

async function bindKernelPackages(): Promise<IdentityRuntime> {
  const [data, events] = await Promise.all([
    import('@forge/kernel-data'),
    import('@forge/kernel-events'),
  ])
  const Repository = (data as { Repository: (entity: string) => unknown }).Repository
  const publish = (events as { publish: (name: string, payload: unknown) => Promise<void> })
    .publish
  return {
    repository: <T,>(entity: string) => Repository(entity) as RepositoryApi<T>,
    publish: (name, payload) => publish(name, payload),
    now: () => new Date(),
  }
}

export async function identityRuntime(): Promise<IdentityRuntime> {
  if (installed !== null) return installed
  bound ??= bindKernelPackages()
  return await bound
}

export async function repository<T>(entity: string): Promise<RepositoryApi<T>> {
  const runtime = await identityRuntime()
  return runtime.repository<T>(entity)
}

export async function now(): Promise<Date> {
  const runtime = await identityRuntime()
  return runtime.now()
}
