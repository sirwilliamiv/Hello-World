/**
 * The seam between kernel.access and the kernel capabilities it builds on:
 * @forge/kernel-data for persistence and @forge/kernel-events for the bus.
 *
 * Role and RoleAssignment are `tenant_scoped: true`, and the tenant predicate
 * is bound by `Repository` — never by a where-clause written here
 * (ARCHITECTURE.md §14.2). `scope` on an assignment is a role's own scope, a
 * domain concept, and is not a substitute for tenancy.
 */

export type Where<T> = { [K in keyof T]?: T[K] }

export type New<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

export interface RepositoryApi<T> {
  find(where: Where<T>): Promise<T | null>
  findMany(where?: Where<T>): Promise<T[]>
  create(values: New<T>): Promise<T>
  update(id: string, values: Partial<New<T>>): Promise<T>
  softDelete(id: string): Promise<void>
  restore(id: string): Promise<void>
}

export interface AccessRuntime {
  repository: <T>(entity: string) => RepositoryApi<T>
  publish: (name: string, payload: Record<string, unknown>) => Promise<void>
  now: () => Date
}

let installed: AccessRuntime | null = null
let bound: Promise<AccessRuntime> | null = null

export function setAccessRuntime(runtime: AccessRuntime): void {
  installed = runtime
  bound = null
}

export function resetAccessRuntime(): void {
  installed = null
  bound = null
}

async function bindKernelPackages(): Promise<AccessRuntime> {
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

export async function accessRuntime(): Promise<AccessRuntime> {
  if (installed !== null) return installed
  bound ??= bindKernelPackages()
  return await bound
}

export async function repository<T>(entity: string): Promise<RepositoryApi<T>> {
  const runtime = await accessRuntime()
  return runtime.repository<T>(entity)
}
