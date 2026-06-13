import { randomBytes, createHash } from "node:crypto";
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
  key_hash: string;
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
 * The full key is hashed with SHA-256 for storage.
 * The prefix (first 8 chars of random segment) is stored separately.
 */

export const API_KEY_PREFIX = "gbk";

export interface GeneratedKey {
  prefix: string;
  keyHash: string;
  fullKey: string;
}

export function generateApiKey(): GeneratedKey {
  const random = randomBytes(32).toString("base64url");
  const prefix = random.slice(0, 8);
  const fullKey = `${API_KEY_PREFIX}_${prefix}_${random}`;
  const keyHash = createHash("sha256").update(fullKey).digest("hex");
  return { prefix, keyHash, fullKey };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
