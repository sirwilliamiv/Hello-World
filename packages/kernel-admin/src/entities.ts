/**
 * The admin entity registry.
 *
 * Call site is generated — templates/kernel.admin/admin-entities.ts.tmpl:
 *
 *   import { registerAdminEntity } from '@forge/kernel-admin'
 *   registerAdminEntity({ name: "Invoice", owner: "pay.invoices" })
 *   registerAdminEntity({ name: "SiteVisit", owner: "<client>" })
 *
 * `{ name, owner }` and nothing more. Everything the console needs beyond that
 * is looked up in kernel.data's entity registry at resolution time, which is
 * what keeps this generated file flat against the client's data model:
 * twelve client entities add twelve lines here, not twelve schemas.
 */

export const CLIENT_OWNER = '<client>' as const

export interface AdminEntityRegistration {
  /** PascalCase entity name; must exist in the kernel.data entity registry. */
  readonly name: string
  /** Capability id, or `<client>` for a manifest-declared entity. */
  readonly owner: string
}

const registrations = new Map<string, AdminEntityRegistration>()

/**
 * Register an entity for admin. Idempotent on name — the generated module may
 * be evaluated more than once by the dev server.
 */
export function registerAdminEntity(entity: AdminEntityRegistration): () => void {
  registrations.set(entity.name, entity)
  return () => {
    if (registrations.get(entity.name) === entity) registrations.delete(entity.name)
  }
}

/** Every registered entity, sorted by name. Deterministic ordering per §10. */
export function adminEntities(): readonly AdminEntityRegistration[] {
  return [...registrations.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function adminEntity(name: string): AdminEntityRegistration | undefined {
  return registrations.get(name)
}

export function isAdminEntity(name: string): boolean {
  return registrations.has(name)
}

/** Manifest-declared entities only. */
export function clientEntities(): readonly AdminEntityRegistration[] {
  return adminEntities().filter((entity) => entity.owner === CLIENT_OWNER)
}

export function resetAdminEntities(): void {
  registrations.clear()
}
