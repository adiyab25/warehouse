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
