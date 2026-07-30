/** Human labels derived from identifiers. Pure, and deliberately dull. */

/** `siteVisit` / `site_visit` / `SiteVisit` → `Site visit`. */
export function humanise(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_\-.]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((w) => w.length > 0)

  if (words.length === 0) return identifier
  const [first, ...rest] = words
  return [(first as string)[0]!.toUpperCase() + (first as string).slice(1), ...rest].join(' ')
}

/** `SiteVisit` → `Site visits`. Overridden by the manifest's `plural`. */
export function pluralise(word: string): string {
  if (/[^aeiou]y$/iu.test(word)) return `${word.slice(0, -1)}ies`
  if (/(?:s|x|z|ch|sh)$/iu.test(word)) return `${word}es`
  return `${word}s`
}

export function entityLabel(name: string, override?: string): string {
  return override ?? humanise(name)
}

export function entityPluralLabel(
  name: string,
  plural?: string,
  labelOverride?: string,
): string {
  if (plural !== undefined) return humanise(plural)
  if (labelOverride !== undefined) return pluralise(labelOverride)
  return humanise(pluralise(name))
}
