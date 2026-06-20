import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";

export const createApiKeyRequestSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().trim().min(1)).optional().default(["agent:operate"]),
});

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const revokeApiKeyParamsSchema = z.object({
  id: z.string().uuid(),
});

export type RevokeApiKeyParams = z.infer<typeof revokeApiKeyParamsSchema>;

export interface ApiKeyRecord {
  id: string;
  institution_id: string;
  label: string;
  prefix: string;
  /**
   * Bcrypt hash of the full API key (cost factor 12). bcrypt
   * embeds a random salt in the hash itself, so this column is
   * NOT unique — two hashes of the same plaintext always differ.
   * Verification is `bcrypt.compare(token, key_bcrypt)`.
   */
  key_bcrypt: string;
  /**
   * HMAC-SHA256(serverSecret, token), hex-encoded. This is a
   * stable, deterministic identifier for the key that allows a
   * single-row index lookup without leaking the plaintext or the
   * bcrypt hash. It is keyed by `AUTH_SESSION_SECRET`, which is
   * a mandatory boot-time env var; rotating the secret
   * invalidates every stored lookup_key and forces re-issuance
   * (the same lifecycle as rotating any other HMAC key).
   */
  lookup_key: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ApiKey {
  id: string;
  institutionId: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyCreatedResponse extends ApiKey {
  /** The plaintext API key. Returned only once on creation. */
  key: string;
}

export function apiKeyFromRecord(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    institutionId: record.institution_id,
    label: record.label,
    prefix: record.prefix,
    scopes: record.scopes.split(",").map((s) => s.trim()),
    createdAt: record.created_at,
    revokedAt: record.revoked_at,
  };
}

/**
 * Generate a new API key.
 *
 * Format: `gbk_<prefix>_<random-base64url>`
 *
 * Storage layout (per-row):
 *  - `prefix`   — first 8 chars of the random segment, stored in
 *                 plaintext for UI display.
 *  - `key_bcrypt` — bcrypt(token, cost=12). NOT unique (per-call
 *                   salt); constant-time verified at request time.
 *  - `lookup_key` — HMAC-SHA256(serverSecret, token), hex. Unique,
 *                   indexed. Used as the equality lookup key when a
 *                   caller presents a bearer token.
 *
 * Plaintext is returned to the caller exactly once and never
 * persisted.
 */

export const API_KEY_PREFIX = "gbk";

/**
 * bcrypt cost factor for stored API key hashes. 12 is the 2026
 * OWASP recommendation: ~250ms on a modern x86 server with the
 * native `bcrypt` binding, ~600ms with the pure-JS `bcryptjs`
 * binding used here. The hashing work is bounded to the request
 * path that creates a key (humans, not requests) so the latency
 * is acceptable.
 */
export const API_KEY_BCRYPT_COST = 12;

export interface GeneratedKey {
  prefix: string;
  keyBcrypt: string;
  lookupKey: string;
  fullKey: string;
}

/**
 * Derive the deterministic lookup key for a plaintext API key.
 * HMAC-SHA256 keyed with the server-side session secret. Equal
 * inputs always produce equal digests, which is what the indexed
 * `lookup_key` column requires. The HMAC is keyed — a database
 * leak alone is insufficient to enumerate valid keys because the
 * attacker also needs `AUTH_SESSION_SECRET`.
 */
export function deriveLookupKey(token: string, serverSecret: string): string {
  return createHmac("sha256", serverSecret).update(token).digest("hex");
}

/**
 * Constant-time-compare a plaintext token against a stored
 * bcrypt hash. Uses bcryptjs's native constant-time comparison;
 * a malformed stored hash resolves to `false` rather than
 * throwing, so an attacker cannot probe for DB corruption via
 * timing.
 */
export async function verifyBcryptApiKey(
  token: string,
  storedHash: string,
): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith("$2")) {
    return false;
  }
  try {
    return await bcrypt.compare(token, storedHash);
  } catch {
    return false;
  }
}

export async function generateApiKey(
  serverSecret: string,
): Promise<GeneratedKey> {
  const random = randomBytes(32).toString("base64url");
  const prefix = random.slice(0, 8);
  const fullKey = `${API_KEY_PREFIX}_${prefix}_${random}`;
  const [keyBcrypt, lookupKey] = await Promise.all([
    bcrypt.hash(fullKey, API_KEY_BCRYPT_COST),
    Promise.resolve(deriveLookupKey(fullKey, serverSecret)),
  ]);
  return { prefix, keyBcrypt, lookupKey, fullKey };
}
