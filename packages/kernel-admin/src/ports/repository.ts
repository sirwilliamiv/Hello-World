/**
 * The kernel.data repository, as kernel.admin consumes it.
 *
 * Spec: `Repository<T>(entity: EntityName): { find, findMany, create, update,
 * softDelete, restore }` — "The only sanctioned data access path. Tenant
 * scoping and append-only enforcement live here, not in convention."
 *
 * kernel.admin issues no SQL of its own. Everything the console reads or writes
 * goes through here, which is what makes §14.2's repository-layer tenant
 * scoping hold for the admin console too — the surface that would otherwise be
 * the easiest place to leak across tenants, because it is the one that lists
 * everything.
 */

export type Row = Record<string, unknown>

export interface FindManyOptions {
  readonly where?: Readonly<Record<string, unknown>>
  /** Free-text search across the entity's searchable fields. */
  readonly search?: string
  readonly orderBy?: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly limit?: number
  readonly offset?: number
  readonly includeDeleted?: boolean
}

export interface FindManyResult<T> {
  readonly rows: readonly T[]
  readonly total: number
}

/**
 * Deliberately not generic over a row type.
 *
 * kernel.admin is generated from a runtime registry, so it never knows an
 * entity's static shape — a generic parameter here would be a type it could
 * only ever satisfy by casting. kernel.data's own `Repository<T>` is generic and
 * assignable to this, so the capability that *does* know the type keeps it.
 */
export interface Repository {
  find(id: string): Promise<Row | undefined>
  findMany(options?: FindManyOptions): Promise<FindManyResult<Row>>
  create(data: Partial<Row>): Promise<Row>
  update(id: string, data: Partial<Row>): Promise<Row>
  softDelete(id: string): Promise<void>
  restore(id: string): Promise<void>
}

export type RepositoryFactory = (entity: string) => Repository

let factory: RepositoryFactory | undefined

export function setRepositoryFactory(next: RepositoryFactory | undefined): void {
  factory = next
}

interface KernelDataModule {
  readonly Repository?: RepositoryFactory
}

/** Resolve a repository for an entity, loading kernel.data lazily. */
export async function repositoryFor(entity: string): Promise<Repository> {
  if (factory === undefined) {
    const mod = (await import('@forge/kernel-data')) as unknown as KernelDataModule
    if (typeof mod.Repository !== 'function') {
      throw new Error(
        '@forge/kernel-data did not expose Repository(). kernel.admin has no other ' +
          'data access path — see kernel.data exposes.interface.Repository.',
      )
    }
    factory = mod.Repository
  }
  return factory(entity)
}
