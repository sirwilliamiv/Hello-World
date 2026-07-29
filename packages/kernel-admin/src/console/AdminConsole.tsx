/**
 * AdminConsole — the `ui_surface` the spec exposes.
 *
 * "Auto-generated CRUD, search, filter, and export for every registered
 *  entity."
 *
 * An async server component. It gates on `admin.access` before resolving
 * anything, then dispatches on the path segments under `/admin`. Wire it in the
 * client repository as:
 *
 *   // src/app/admin/[[...segments]]/page.tsx
 *   import { AdminConsole } from '@forge/kernel-admin'
 *   import { currentUser } from '@forge/kernel-identity'
 *
 *   export default async function Page({ params }) {
 *     const { segments = [] } = await params
 *     return <AdminConsole user={await currentUser()} segments={segments} />
 *   }
 */

import { Card } from '@forge/kernel-ui'

import { adminEntities } from '../entities.js'
import { mayAdmin, requireAdmin } from '../guard.js'
import { ADMIN_EXPORT, type AdminUser } from '../ports/access.js'
import { loadEntitySource, type EntitySource } from '../ports/entities.js'
import { repositoryFor, type Row } from '../ports/repository.js'
import {
  resolveDetailView,
  resolveListView,
  type ResolveOptions,
} from '../resolve.js'
import type { AdminSlots } from '../slots.js'
import { EntityDetailView } from './EntityDetailView.js'
import { EntityListView } from './EntityListView.js'

export interface AdminConsoleProps {
  readonly user: AdminUser | null
  /** Path segments under `/admin`. `[]` renders the index. */
  readonly segments?: readonly string[]
  readonly searchParams?: Readonly<Record<string, string>>
  readonly slots?: AdminSlots
  /** Defaults to kernel.data's entity registry. */
  readonly source?: EntitySource
}

function Forbidden() {
  return (
    <Card title="Not permitted" description="This area requires the admin.access permission.">
      <p>If you believe you should have access, ask an owner to grant you an admin role.</p>
    </Card>
  )
}

function NotFound({ what }: { readonly what: string }) {
  return <Card title="Not found" description={what} />
}

async function Index({ options }: { readonly options: ResolveOptions }) {
  const views = await Promise.all(
    adminEntities().map((registration) => resolveListView(registration.name, options)),
  )

  return (
    <Card
      title="Admin"
      description={`${views.length} registered ${views.length === 1 ? 'entity' : 'entities'}`}
    >
      <ul className="fui-nav__list">
        {views.map((view) => (
          <li key={view.entity}>
            <a className="fui-nav__link" href={view.path}>
              {view.pluralLabel}
              <span className="fui-field__hint">
                {view.isClientEntity ? 'declared in the manifest' : view.owner}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export async function AdminConsole({
  user,
  segments = [],
  searchParams = {},
  slots,
  source,
}: AdminConsoleProps) {
  // Gate first: nothing below runs for a user without admin.access.
  if (!(await mayAdmin(user))) return <Forbidden />
  await requireAdmin(user)

  const resolvedSource = source ?? (await loadEntitySource())
  const options: ResolveOptions = {
    source: resolvedSource,
    ...(slots === undefined ? {} : { slots }),
  }

  const [entityName, id] = segments
  if (entityName === undefined) return <Index options={options} />

  const registration = adminEntities().find((e) => e.name === entityName)
  if (registration === undefined) return <NotFound what={`No admin surface for ${entityName}.`} />

  if (id === undefined) {
    const view = await resolveListView(entityName, options)
    if (view.custom !== null) {
      const Custom = view.custom
      return (
        <Custom
          entity={resolvedSource.get(entityName)!}
          registration={registration}
          user={user!}
          view="list"
          searchParams={searchParams}
        />
      )
    }

    const repository = await repositoryFor(entityName)
    const result = await repository.findMany({
      orderBy: { field: view.defaultSort.field, direction: view.defaultSort.direction },
      limit: view.pageSize,
    })
    return (
      <EntityListView
        view={view}
        rows={result.rows as readonly Row[]}
        total={result.total}
        canExport={await mayAdmin(user, ADMIN_EXPORT)}
      />
    )
  }

  const view = await resolveDetailView(entityName, options)
  if (view.custom !== null) {
    const Custom = view.custom
    return (
      <Custom
        entity={resolvedSource.get(entityName)!}
        registration={registration}
        user={user!}
        view="detail"
        id={id}
        searchParams={searchParams}
      />
    )
  }

  const repository = await repositoryFor(entityName)
  const row = await repository.find(id)
  if (row === undefined) return <NotFound what={`${entityName} ${id} does not exist.`} />

  return <EntityDetailView view={view} row={row as Row} />
}
