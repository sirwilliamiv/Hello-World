/**
 * Subscription pattern matching.
 *
 * Three forms, matching schemas/capability.schema.json's `eventPattern`:
 *   - an exact name:  `payment.succeeded`
 *   - a segment glob: `entity.*`   — `*` matches exactly one segment
 *   - the firehose:   `**`         — matches every event in the system
 *
 * `**` may also appear as a trailing segment (`org.**`), where it matches one or
 * more remaining segments. Keeping the grammar this small is deliberate: the
 * resolved graph derives the webhook catalog and the automation trigger list
 * from these patterns, and a regex dialect would not be derivable.
 */

import { InvalidEventPatternError } from './errors.js'

const SEGMENT = /^[a-z0-9_]+$/
const WILDCARD = '*'
const FIREHOSE = '**'

export function assertValidPattern(pattern: string): void {
  if (pattern === FIREHOSE) return
  const segments = pattern.split('.')
  const valid = segments.every((segment, index) => {
    if (segment === WILDCARD) return true
    if (segment === FIREHOSE) return index === segments.length - 1
    return SEGMENT.test(segment)
  })
  if (!valid || segments.length === 0) throw new InvalidEventPatternError(pattern)
}

/** True when `name` is delivered to a subscription registered for `pattern`. */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === FIREHOSE) return true

  const patternSegments = pattern.split('.')
  const nameSegments = name.split('.')

  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i]
    if (patternSegment === FIREHOSE) {
      // Trailing '**' consumes one or more remaining segments.
      return nameSegments.length > i
    }
    const nameSegment = nameSegments[i]
    if (nameSegment === undefined) return false
    if (patternSegment === WILDCARD) continue
    if (patternSegment !== nameSegment) return false
  }

  return patternSegments.length === nameSegments.length
}
