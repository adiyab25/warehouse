import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque token helpers shared by sessions and api clients.
 *
 * A token is a credential that is shown to its holder ONCE and then stored only
 * as a hash — so the two halves (generate, hash) live together here rather than
 * being copied into session.ts and api-clients.ts where they would drift.
 */

/** Bytes of entropy in an issued token: 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

/**
 * Mints a fresh, opaque token. `base64url` so the token survives a cookie and a
 * URL untouched; 32 random bytes make it unguessable.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The one-way lookup hash of a token: sha256, hex.
 *
 * Deliberately a plain (fast) hash and NOT `hashPassword`'s scrypt. A token is
 * high-entropy random already — there is no dictionary to slow an attacker
 * down — and the hash is a LOOKUP key (`where token_hash = $1`), so it must be
 * deterministic and cheap. Passwords are the opposite: low-entropy and never
 * looked up by value, which is why they carry a per-row salt and a slow KDF.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
