/**
 * The session cookie — its NAME, in one place, and WHY that name.
 *
 * `__Host-` in PRODUCTION. A `__Host-` prefixed cookie is only accepted by a
 * browser when it is `Secure`, has `Path=/`, and carries NO `Domain` — which is
 * precisely what a session cookie wants: it cannot be set or overwritten by a
 * sibling subdomain (a compromised `blog.example.com` cannot fixate
 * `example.com`'s session), and it cannot be read over plain http. None of that
 * is enforceable by a name alone, so the name and the attributes must agree —
 * see `sessionCookieOptions` in src/app/(auth)/sign-in/contract.ts, which sets
 * `secure` whenever this name is used.
 *
 * The exception is DEVELOPMENT, which serves plain `http://localhost`. A
 * `__Host-` cookie requires `Secure`, and a browser on plain http will drop a
 * `Secure` cookie, so a development server using `__Host-session` would look
 * signed-in in the database and signed-out in the browser. Outside production
 * the name is therefore the plain, unambiguous `session`.
 *
 * This module is DELIBERATELY dependency-free (no `next/*`, no `pg`): the
 * middleware runs it on the edge runtime, and the server action on Node, and
 * both must resolve the same name.
 */

/**
 * The cookie name for a given Node environment. Pure, so a test can ask what
 * the PRODUCTION name is without pretending to be production.
 */
export function sessionCookieName(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  return nodeEnv === 'production' ? '__Host-session' : 'session';
}

/** The cookie the raw session token lives in, for THIS process. */
export const SESSION_COOKIE = sessionCookieName();
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing — the credential a PERSON signs in with.
 *
 * Uses node:crypto `scrypt` directly: NO new dependency. Each hash carries its
 * OWN random salt (so two users with the same password get different hashes, and
 * a rainbow table is useless), and verification is TIMING-SAFE — an attacker
 * cannot learn how much of a guess matched by measuring how long the comparison
 * took.
 *
 * The stored format is a single string, self-describing so a future scheme
 * change can be told apart from this one:
 *
 *     scrypt$<salt-hex>$<derived-key-hex>
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Random salt size, in bytes. */
const SALT_BYTES = 16;

/** Derived key length, in bytes. 64 = 512 bits, comfortably past scrypt's needs. */
const KEY_LENGTH = 64;

const SCHEME = 'scrypt';

/** Hex characters only — anything else is a malformed stored hash. */
const HEX = /^[0-9a-f]+$/i;

/**
 * Hashes a password into a self-describing, salted string.
 *
 * The salt is generated here with a CSPRNG and never leaves the returned value,
 * so two calls with the SAME password produce DIFFERENT hashes — a stolen table
 * cannot be attacked with one pass over a pre-computed dictionary.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string') {
    throw new Error('hashPassword: password must be a string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` — never throws — for a malformed stored hash (the wrong
 * number of fields, an unknown scheme, non-hex salt or key, a key of the wrong
 * length). A corrupt row is an authentication failure, not a 500: a caller that
 * only ever branches on `true`/`false` cannot be made to leak whether a row
 * exists by the error it does or does not see.
 *
 * The comparison is TIMING-SAFE: because a malformed hash can never match
 * anyway, the only secret-dependent work is done on buffers of KNOWN, EQUAL
 * length via {@link timingSafeEqual}, so a byte-by-byte early exit cannot
 * reveal how much of a guess was correct.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;

  const parsed = parse(hash);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plain, parsed.salt, parsed.key.length);
  } catch {
    // A scrypt failure (an unusable salt, resource limits) is a failed
    // verification, not an exception the caller has to guard against.
    return false;
  }

  // `derived` and `parsed.key` are the same length by construction, so
  // timingSafeEqual is safe to call — and its whole point is that it never
  // short-circuits on the first differing byte. This comparison is DELIBERATELY
  // `timingSafeEqual`, never `===` (or a hex-string equality): a byte-by-byte
  // string comparison exits at the first differing character, and the time that
  // takes reveals how much of a guess was correct. The length guard above keeps
  // the two buffers equal so the comparison itself can never throw.
  return timingSafeEqual(derived, parsed.key);
}

/** The salt and derived key of a well-formed stored hash, or null if malformed. */
function parse(hash: string): { salt: Buffer; key: Buffer } | null {
  const parts = hash.split('$');
  if (parts.length !== 3) return null;
  const [scheme, saltHex, keyHex] = parts;
  if (scheme !== SCHEME) return null;
  if (!saltHex || saltHex.length % 2 !== 0 || !HEX.test(saltHex)) return null;
  if (!keyHex || keyHex.length !== KEY_LENGTH * 2 || !HEX.test(keyHex)) return null;
  return { salt: Buffer.from(saltHex, 'hex'), key: Buffer.from(keyHex, 'hex') };
}
import { createHash } from 'node:crypto';

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

/*
 * The permission keys and `can()` live in ./keys.ts — a module with NO Node
 * built-ins — and are re-exported here so a server caller has one import.
 * A CLIENT component must import '@/modules/auth/keys' instead: this file
 * pulls in `node:crypto`.
 */
export { PERMISSION, can, canAll, type PermissionKey } from './keys.ts';
