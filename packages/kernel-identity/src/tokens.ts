import { createHash, randomBytes } from 'node:crypto'

/**
 * Opaque bearer tokens for sessions, email verification, and password reset.
 *
 * The token is returned to the caller once and only its SHA-256 digest is
 * stored, so a database disclosure does not hand over live sessions or reset
 * links. Lookup is by digest, which keeps it a single indexed equality query.
 */

const TOKEN_BYTES = 32

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
