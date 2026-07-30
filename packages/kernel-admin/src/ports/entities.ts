/**
 * The kernel.data entity registry, as kernel.admin consumes it.
 *
 * `registers`/`requires` say kernel.admin may depend on kernel.data, and
 * `templates/kernel.admin/admin-entities.ts.tmpl` registers only
 * `{ name, owner }` — everything else about an entity (its fields, its flags)
 * is looked up here. That is deliberate: the generated admin file must not grow
 * when the client's data model grows, or kernel.admin breaches the §4 budget
 * exactly the way kernel.data did before the `<client>` recategorisation (§9.1).
 *
 * The import of `@forge/kernel-data` is dynamic and behind a settable port for
 * two reasons: the registry is the *only* thing kernel.admin needs from it, and
 * making the seam explicit lets the generic-path tests run against a registry
 * they construct, which is the only honest way to prove "every registered
 * entity, including manifest-declared ones, resolves a list and a detail view".
 */

/** Field types the manifest schema permits, plus `ref:`/`refs:` references. */
export type ScalarFieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'money'
  | 'email'
  | 'phone'
  | 'url'
  | 'json'
  | 'file'

export type FieldType = ScalarFieldType | `ref:${string}` | `refs:${string}`

export interface EntityFieldDescriptor {
  readonly name: string
  readonly type: FieldType
  readonly required?: boolean
  readonly unique?: boolean
  readonly indexed?: boolean
  readonly enum?: readonly string[]
  readonly label?: string
  readonly help?: string
  readonly default?: unknown
}

export interface EntityDescriptor {
  /** PascalCase, unique across the resolved graph. */
  readonly name: string
  /** Capability id, or `<client>` for a manifest-declared entity. */
  readonly owner: string
  readonly plural?: string
  readonly description?: string
  readonly tenantScoped?: boolean
  readonly personalData?: boolean
  readonly listable?: boolean
  readonly searchable?: boolean
  /** Rows may never be updated or deleted; admin must not offer those actions. */
  readonly appendOnly?: boolean
  readonly fields: readonly EntityFieldDescriptor[]
}

/** The shape kernel.admin needs from `@forge/kernel-data`'s `entities` registry. */
export interface EntitySource {
  get(name: string): EntityDescriptor | undefined
  all(): readonly EntityDescriptor[]
}

let source: EntitySource | undefined

/**
 * Install the entity source.
 *
 * Called with `@forge/kernel-data`'s registry by {@link loadEntitySource}, and
 * by tests with a registry they built.
 */
export function setEntitySource(next: EntitySource | undefined): void {
  source = next
}

export function entitySource(): EntitySource | undefined {
  return source
}

interface KernelDataModule {
  readonly entities?: {
    get?(name: string): EntityDescriptor | undefined
    all?(): readonly EntityDescriptor[]
  }
}

/**
 * Resolve the entity source from `@forge/kernel-data` if one has not been
 * installed. Dynamic so that importing kernel.admin's pure resolution layer
 * does not pull the data layer into a bundle that does not need it.
 */
export async function loadEntitySource(): Promise<EntitySource> {
  if (source !== undefined) return source
  const mod = (await import('@forge/kernel-data')) as unknown as KernelDataModule
  const registry = mod.entities
  if (registry?.get === undefined || registry.all === undefined) {
    throw new Error(
      '@forge/kernel-data did not expose an `entities` registry with get()/all(). ' +
        'kernel.admin generates every surface from it (see kernel.data exposes.registry.entities).',
    )
  }
  const resolved: EntitySource = {
    get: (name) => registry.get?.(name),
    all: () => registry.all?.() ?? [],
  }
  source = resolved
  return resolved
}
