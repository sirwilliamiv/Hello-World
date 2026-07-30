import { fileURLToPath } from 'node:url'

import type { UserConfig } from 'vitest/config'

/**
 * kernel.admin's tests exercise the pure resolution and routing layers, which
 * import the two React-free entry points of `@forge/kernel-ui`.
 *
 * The aliases point at the same files the workspace symlink would, so they
 * change nothing about what is under test; they exist so the suite runs before
 * `pnpm install` has linked the workspace, which matters because these are the
 * tests that prove the generic admin path works.
 *
 * `UserConfig` is imported as a type only, so this file needs nothing resolved
 * at runtime beyond `node:url`.
 */
const uiSrc = fileURLToPath(new URL('../kernel-ui/src', import.meta.url))

const config: UserConfig = {
  resolve: {
    alias: {
      '@forge/kernel-ui/registry': `${uiSrc}/registry.ts`,
      '@forge/kernel-ui/data': `${uiSrc}/components/datagrid-model.ts`,
    },
  },
}

export default config
