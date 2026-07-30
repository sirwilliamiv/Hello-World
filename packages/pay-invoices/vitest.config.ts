/**
 * No aliases.
 *
 * This file used to alias hand-written doubles over `@forge/kernel-money`,
 * `@forge/kernel-events`, `@forge/docs-generation`, `drizzle-orm/pg-core` and
 * `react/jsx-runtime` while those packages were unavailable. All five now resolve
 * for real, so the suite runs against them and the doubles are gone.
 *
 * What remains under `src/testing/` are seams rather than substitutes: the
 * in-memory `InvoiceStore` (row locks and an undo log, so the concurrency tests
 * exercise this package's code rather than Postgres), and in-memory ports for the
 * capabilities docs.generation requires but pay.invoices does not.
 */
export default {
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
}
