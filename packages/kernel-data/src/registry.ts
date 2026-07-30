/**
 * The entity registry — the `entities` registry in the capability spec.
 *
 * Every entity in the resolved graph lands here: capability-owned entities from
 * `src/generated/kernel.data/entities.ts` and manifest-declared client entities
 * from `src/generated/kernel.data/client-entities.ts`. Registering is what buys
 * an entity its repository, its lifecycle events, and therefore admin CRUD,
 * audit, search, webhooks, automation and reporting.
 */

import { EntityNotRegisteredError } from './errors.js'
import type { EntityDefinition, EntityName, EntityRegistration } from './types.js'

const registry = new Map<EntityName, EntityDefinition>()

/**
 * Derive the physical table name: `ExchangeRate` → `exchange_rates`.
 *
 * Deliberately simple and deterministic — a naming rule with special cases is a
 * naming rule that generated SQL and hand-written migrations will disagree about.
 * An entity whose plural is irregular declares `table` explicitly.
 */
export function defaultTableName(entity: EntityName): string {
  const snake = entity
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()

  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es`
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`
  return `${snake}s`
}

/**
 * Register an entity. Idempotent for an identical registration so the generated
 * module can be evaluated more than once (Next.js will, in development).
 */
export function registerEntity(registration: EntityRegistration): EntityDefinition {
  const definition: EntityDefinition = {
    name: registration.name,
    owner: registration.owner,
    table: registration.table ?? defaultTableName(registration.name),
    tenantScoped: registration.tenantScoped ?? true,
    appendOnly: registration.appendOnly ?? false,
    personalData: registration.personalData ?? false,
    listable: registration.listable ?? true,
    searchable: registration.searchable ?? false,
    fields: registration.fields ?? [],
    description: registration.description,
  }
  registry.set(definition.name, definition)
  return definition
}

export function getEntity(name: EntityName): EntityDefinition {
  const definition = registry.get(name)
  if (definition === undefined) throw new EntityNotRegisteredError(name)
  return definition
}

export function tryGetEntity(name: EntityName): EntityDefinition | undefined {
  return registry.get(name)
}

export function isRegistered(name: EntityName): boolean {
  return registry.has(name)
}

/** Every registered entity, sorted by name so derived output is deterministic. */
export function listEntities(): EntityDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Entities a given capability owns. Drives the per-capability leak tests. */
export function entitiesOwnedBy(owner: string): EntityDefinition[] {
  return listEntities().filter((entity) => entity.owner === owner)
}

/** Test and hot-reload helper. Not used by generated code. */
export function clearEntities(): void {
  registry.clear()
}

/**
 * The registry as a single object, matching the `exposes` entry of kind
 * 'registry'. Capabilities contribute through `registerEntity`.
 */
export const entities = {
  register: registerEntity,
  get: getEntity,
  tryGet: tryGetEntity,
  has: isRegistered,
  list: listEntities,
  ownedBy: entitiesOwnedBy,
  clear: clearEntities,
} as const
