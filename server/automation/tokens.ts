/**
 * Link tokens: 256 random bits, shown once (in the link), stored only as a sha256 hex digest.
 * A token that does not have the exact shape is rejected before anything touches the database.
 */
import { createHash, randomBytes } from 'node:crypto'

/** base64url of 32 bytes: always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export const isTokenShape = (s: string) => TOKEN_PATTERN.test(s)
