import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * React is an optional peer dependency — needed only by the `AccountSettings`
 * UI surface, which `src/index.ts` re-exports. When it is absent from the
 * workspace, importing the package entry point would fail before a single
 * assertion ran, so a runtime placeholder is aliased in. The alias is never
 * applied over a real React, which makes this file inert once one is installed.
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

const double = (file: string): string => path.join(here, 'test', 'doubles', file)

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
