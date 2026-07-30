/** Class-name join. Kept here so no component needs a dependency for it. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}
