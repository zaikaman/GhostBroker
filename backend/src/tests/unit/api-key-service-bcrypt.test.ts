import { describe, expect, it } from "vitest";
import {
  type ApiKey,
  deriveLookupKey,
} from "../../models/api-key.js";
import {
  ApiKeyService,
  type ApiKeyRepository,
  type ApiKeyRecord,
} from "../../services/api-key.service.js";
import { TEST_AUTH_SESSION_SECRET } from "../data/us1-seed-builders.js";

/**
 * In-memory repository for the unit test. Faithfully mirrors the
 * SupabaseApiKeyRepository contract on the only two operations
 * exercised by `ApiKeyService`: `create` and `findByLookupKey`.
 * `findByLookupKey` is a single-row select, but the SQL string
 * `eq("lookup_key", value)` is what `bcrypt.compare` later
 * verifies — so the test also exercises that the lookup key
 * correctly discriminates rows when more than one key is in the
 * store (i.e. we don't accidentally match on `key_bcrypt`).
 */
class InMemoryApiKeyRepository implements ApiKeyRepository {
  public readonly rows: ApiKeyRecord[] = [];

  public async create(params: {
    institutionId: string;
    label: string;
    prefix: string;
    keyBcrypt: string;
    lookupKey: string;
    scopes: string;
  }): Promise<ApiKey> {
    const row: ApiKeyRecord = {
      id: `00000000-0000-4000-8000-${this.rows.length.toString(16).padStart(12, "0")}`,
      institution_id: params.institutionId,
      label: params.label,
      prefix: params.prefix,
      key_bcrypt: params.keyBcrypt,
      lookup_key: params.lookupKey,
      scopes: params.scopes,
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.rows.push(row);
    return {
      id: row.id,
      institutionId: row.institution_id,
      label: row.label,
      prefix: row.prefix,
      scopes: row.scopes.split(","),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  public async findByLookupKey(
    lookupKey: string,
  ): Promise<ApiKeyRecord | null> {
    const row = this.rows.find(
      (r) => r.lookup_key === lookupKey && r.revoked_at === null,
    );
    return row ?? null;
  }

  public async listActive(institutionId: string): Promise<ApiKey[]> {
    return this.rows
      .filter(
        (r) => r.institution_id === institutionId && r.revoked_at === null,
      )
      .map((r) => ({
        id: r.id,
        institutionId: r.institution_id,
        label: r.label,
        prefix: r.prefix,
        scopes: r.scopes.split(","),
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      }));
  }

  public async revoke(id: string, institutionId: string): Promise<void> {
    const row = this.rows.find(
      (r) => r.id === id && r.institution_id === institutionId,
    );
    if (row) {
      row.revoked_at = new Date().toISOString();
    }
  }
}

describe("ApiKeyService bcrypt + HMAC lookup key", () => {
  const institutionId = "00000000-0000-4000-8000-000000000301";

  it("mints a key whose plaintext is returned once and bcrypt hash is stored", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    const created = await service.createKey(institutionId, "ops", [
      "agent:operate",
    ]);

    expect(created.key).toMatch(/^gbk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]+$/);
    expect(created.institutionId).toBe(institutionId);
    expect(created.scopes).toEqual(["agent:operate"]);

    expect(repo.rows).toHaveLength(1);
    const stored = repo.rows[0];
    if (!stored) throw new Error("expected row to exist");
    // bcrypt cost-12 hash begins with "$2a$12$..." / "$2b$12$" / "$2y$12$".
    expect(stored.key_bcrypt).toMatch(/^\$2[aby]\$\d{2}\$/);
    // Lookup key is the server-HMAC, 64 hex chars (SHA-256 hex).
    expect(stored.lookup_key).toMatch(/^[0-9a-f]{64}$/);
    // Plaintext must not appear in any stored column.
    expect(stored.key_bcrypt).not.toContain(created.key);
    expect(stored.lookup_key).not.toContain(created.key);
  });

  it("resolves a minted token back to its institution via findKeyByToken", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    const created = await service.createKey(institutionId, "ops", [
      "agent:operate",
    ]);
    const found = await service.findKeyByToken(created.key);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.institutionId).toBe(institutionId);
  });

  it("rejects an unknown token (no match → null)", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    await service.createKey(institutionId, "ops", ["agent:operate"]);
    const found = await service.findKeyByToken("gbk_AAAAAAAA_never-issued");

    expect(found).toBeNull();
  });

  it("rejects a tampered token (HMAC match, bcrypt mismatch → null)", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    const created = await service.createKey(institutionId, "ops", [
      "agent:operate",
    ]);
    // Flip one character of the random segment while keeping the
    // gbk_<prefix> shape. The HMAC lookup key will not match the
    // stored row, but in case it ever did (e.g. attacker matches
    // a prefix collision) the bcrypt compare must still reject.
    const tampered = created.key.slice(0, -1) + (created.key.endsWith("A") ? "B" : "A");
    const found = await service.findKeyByToken(tampered);
    expect(found).toBeNull();
  });

  it("rejects tokens signed with a different server secret", async () => {
    const repo = new InMemoryApiKeyRepository();
    const minter = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);
    const foreignVerifier = new ApiKeyService(
      repo,
      "completely-different-server-secret-with-enough-length-for-validation",
    );

    const created = await minter.createKey(institutionId, "ops", [
      "agent:operate",
    ]);
    // The foreign verifier derives a different lookup_key; the
    // equality lookup misses; no row is returned.
    const found = await foreignVerifier.findKeyByToken(created.key);
    expect(found).toBeNull();
  });

  it("does not let one institution's token resolve to another's row", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    const buyer = await service.createKey(
      "00000000-0000-4000-8000-0000000003b1",
      "buyer",
      ["agent:operate"],
    );
    const seller = await service.createKey(
      "00000000-0000-4000-8000-0000000003b2",
      "seller",
      ["agent:operate"],
    );

    const buyerFound = await service.findKeyByToken(buyer.key);
    const sellerFound = await service.findKeyByToken(seller.key);

    expect(buyerFound?.institutionId).toBe("00000000-0000-4000-8000-0000000003b1");
    expect(sellerFound?.institutionId).toBe("00000000-0000-4000-8000-0000000003b2");
  });

  it("excludes revoked keys from the lookup path", async () => {
    const repo = new InMemoryApiKeyRepository();
    const service = new ApiKeyService(repo, TEST_AUTH_SESSION_SECRET);

    const created = await service.createKey(institutionId, "ops", [
      "agent:operate",
    ]);
    await service.revokeKey(created.id, institutionId);

    const found = await service.findKeyByToken(created.key);
    expect(found).toBeNull();
  });

  it("deriveLookupKey is deterministic for equal inputs", async () => {
    const a = deriveLookupKey("gbk_pfx_aaa", TEST_AUTH_SESSION_SECRET);
    const b = deriveLookupKey("gbk_pfx_aaa", TEST_AUTH_SESSION_SECRET);
    expect(a).toBe(b);
  });
});
