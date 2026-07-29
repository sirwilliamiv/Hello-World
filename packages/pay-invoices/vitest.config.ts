import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Where a real implementation is present on disk it is used; where it is not, a
 * faithful double is aliased in. This file becomes inert as the rest of the
 * workspace lands.
 */
function resolvable(id: string): boolean {
  try {
    require.resolve(id)
    return true
  } catch {
    return false
  }
}

function workspacePackageIsImplemented(dir: string): boolean {
  const entry = path.join(here, '..', dir, 'src', 'index.ts')
  return existsSync(entry) && readFileSync(entry, 'utf8').trim().length > 0
}

const double = (file: string): string => path.join(here, 'src', 'testing', 'doubles', file)

const alias: Record<string, string> = {}
if (!workspacePackageIsImplemented('kernel-money')) {
  alias['@forge/kernel-money'] = double('kernel-money.ts')
}
if (!workspacePackageIsImplemented('kernel-events')) {
  alias['@forge/kernel-events'] = double('kernel-events.ts')
}
if (!workspacePackageIsImplemented('docs-generation')) {
  alias['@forge/docs-generation'] = double('docs-generation.ts')
}
if (!resolvable('drizzle-orm/pg-core')) {
  alias['drizzle-orm/pg-core'] = double('drizzle-pg-core.ts')
}
if (!resolvable('react/jsx-runtime')) {
  alias['react/jsx-runtime'] = double('jsx-runtime.ts')
}

export default {
  resolve: { alias },
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
}
