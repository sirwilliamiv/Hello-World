/**
 * The single boundary between this capability and the ones it requires:
 * `kernel.data` for persistence, `kernel.events` for the bus, `kernel.identity` for
 * the actor, `kernel.money` for every money value that appears in a document, and
 * `data.files` for storing the rendering.
 *
 * Loaded lazily so a test can render, hash, and compare documents without a database.
 */
import { documents } from './config.js'

export interface RepositoryLike<T extends { id: string }> {
  find(id: string): Promise<T | null>
  findMany(where?: Partial<T>): Promise<T[]>
  create(value: T): Promise<T>
  update(id: string, patch: Partial<T>): Promise<T>
  softDelete(id: string): Promise<void>
  restore(id: string): Promise<void>
  delete?(id: string): Promise<void>
}

/**
 * `kernel.money`. Money is integer minor units plus a currency — never a float, and
 * never formatted by this package, so an amount reads identically in an invoice, a
 * quote, and a report.
 */
export interface MoneyLike {
  of(minor: number, currency: string): { format(): string }
}

/** The slice of `@forge/data-files` a document needs. */
export interface FilesPort {
  storeServerFile(input: {
    filename: string
    contentType: string
    bytes: Uint8Array
    ownerId?: string
    attachedTo?: { entity: string; id: string }
    storageKey?: string
  }): Promise<{ id: string }>
  signedUrl(file: string, ttlSeconds?: number): Promise<string>
}

export interface DocsRuntime {
  repository<T extends { id: string }>(entity: string): RepositoryLike<T>
  publish(name: string, payload: Record<string, unknown>): Promise<void>
  currentUser(): Promise<{ id: string } | null>
  money: MoneyLike
  files: FilesPort
}

let defaultRuntime: Promise<DocsRuntime> | null = null

async function loadDefaultRuntime(): Promise<DocsRuntime> {
  const [data, events, identity, money, filesPkg] = await Promise.all([
    import('@forge/kernel-data'),
    import('@forge/kernel-events'),
    import('@forge/kernel-identity'),
    import('@forge/kernel-money'),
    import('@forge/data-files'),
  ])

  const kd = data as unknown as {
    Repository: <T extends { id: string }>(entity: string) => RepositoryLike<T>
  }
  const ke = events as unknown as {
    publish: (name: string, payload: Record<string, unknown>) => Promise<void>
  }
  const ki = identity as unknown as { currentUser: () => Promise<{ id: string } | null> }
  const km = money as unknown as { Money: MoneyLike }
  const kf = filesPkg as unknown as FilesPort

  return {
    repository: kd.Repository,
    publish: ke.publish,
    currentUser: ki.currentUser,
    money: km.Money,
    files: { storeServerFile: kf.storeServerFile, signedUrl: kf.signedUrl },
  }
}

export async function runtime(): Promise<DocsRuntime> {
  const injected = documents().runtime
  if (injected !== undefined) return injected
  defaultRuntime ??= loadDefaultRuntime()
  return defaultRuntime
}
