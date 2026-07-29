import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * These tests import @forge/kernel-identity for real — the registration and
 * login they drive are the point of the "default role on registration" and
 * "guard denies without permission" smoke tests. That entry point re-exports a
 * React UI surface, and React is only an optional peer, so a runtime
 * placeholder is aliased in when none is installed. The alias is never applied
 * over a real React.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function resolvable(id: string): boolean {
  try {
    require.resolve(id)
    return true
  } catch {
    return false
  }
}

const double = (file: string): string =>
  path.join(here, '..', 'kernel-identity', 'test', 'doubles', file)

const alias: Record<string, string> = {}
if (!resolvable('react')) alias['react'] = double('react.ts')
if (!resolvable('react/jsx-runtime')) alias['react/jsx-runtime'] = double('jsx-runtime.ts')

export default {
  resolve: { alias },
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
}
