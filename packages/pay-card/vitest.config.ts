/**
 * No module aliases.
 *
 * These tests run against the real @forge/kernel-money, @forge/kernel-events and
 * @forge/kernel-identity, the real drizzle-orm/pg-core and the real
 * react/jsx-runtime. The only stand-ins left are the two things a unit test
 * cannot have for real — the Stripe API and Postgres — and both are injected
 * through `configurePayments`, not aliased over a module.
 */
export default {
  esbuild: { jsx: 'automatic' as const },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
}
