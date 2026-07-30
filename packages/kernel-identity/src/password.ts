import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing.
 *
 * scrypt from node:crypto — a memory-hard KDF in the platform's own audited
 * implementation. Argon2id would be the other defensible choice; it needs a
 * native module, and inventing a KDF is never a choice. Parameters are stored
 * alongside the digest so they can be raised later and old digests re-hashed on
 * next successful login (`needsRehash`).
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

interface ScryptParams {
  N: number
  r: number
  p: number
}

/** OWASP's minimum for scrypt: N=2^15 costs ~32 MiB per hash at r=8. */
const CURRENT: ScryptParams = { N: 32768, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16
const PREFIX = 'scrypt'

function maxmem(params: ScryptParams): number {
  // node's default cap is 32 MiB, which N=2^15 exceeds. 256 * N * r leaves headroom.
  return 256 * params.N * params.r
}

function encode(params: ScryptParams, salt: Buffer, derived: Buffer): string {
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

interface DecodedHash {
  params: ScryptParams
  salt: Buffer
  derived: Buffer
}

function decode(encoded: string): DecodedHash | null {
  const parts = encoded.split('$')
  if (parts.length !== 6) return null
  const [prefix, n, r, p, salt, derived] = parts
  if (prefix !== PREFIX) return null
  if (n === undefined || r === undefined || p === undefined) return null
  if (salt === undefined || derived === undefined) return null
  const params: ScryptParams = { N: Number(n), r: Number(r), p: Number(p) }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return null
  }
  return { params, salt: Buffer.from(salt, 'base64'), derived: Buffer.from(derived, 'base64') }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...CURRENT,
    maxmem: maxmem(CURRENT),
  })
  return encode(CURRENT, salt, derived)
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = decode(encoded)
  if (parsed === null) return false
  const derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.derived.length, {
    ...parsed.params,
    maxmem: maxmem(parsed.params),
  })
  if (derived.length !== parsed.derived.length) return false
  return timingSafeEqual(derived, parsed.derived)
}

/** True when the stored digest used weaker parameters than the current policy. */
export function needsRehash(encoded: string): boolean {
  const parsed = decode(encoded)
  if (parsed === null) return true
  return (
    parsed.params.N < CURRENT.N ||
    parsed.params.r < CURRENT.r ||
    parsed.params.p < CURRENT.p ||
    parsed.derived.length < KEY_LENGTH
  )
}
