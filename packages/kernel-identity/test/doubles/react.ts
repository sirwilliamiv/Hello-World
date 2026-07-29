/**
 * React is an optional peer of this package: it is needed only by the
 * `AccountSettings` UI surface, which `src/index.ts` re-exports. These tests
 * never render it, so when React is absent from the workspace this double keeps
 * importing the package entry point from failing. Types still come from
 * @types/react; this stands in at runtime only, and is never aliased over a
 * real React — see vitest.config.ts.
 */
export const useState = <S,>(initial: S): [S, (next: S) => void] => [initial, () => {}]
export const useEffect = (_effect: () => void, _deps?: unknown[]): void => {}
export const useCallback = <T,>(fn: T, _deps?: unknown[]): T => fn
