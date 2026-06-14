import { describe, expect, it } from "vitest";
import { InMemoryIntentLockClient } from "../support/in-memory-intent-lock-client.js";

describe("in-memory intent lock client", () => {
  it("creates a row with the given fields", async () => {
    const client = new InMemoryIntentLockClient();
    const row = await client.create({
      intentHandle: "intent_1",
      institutionId: "00000000-0000-4000-8000-000000000001",
      assetCode: "USDC",
      amount: 1000,
      correlationRef: "corr_1",
      agentDid: "did:t3n:agent:1",
    });

    expect(row).toMatchObject({
      intentHandle: "intent_1",
      institutionId: "00000000-0000-4000-8000-000000000001",
      assetCode: "USDC",
      amount: 1000,
      correlationRef: "corr_1",
      agentDid: "did:t3n:agent:1",
    });
    expect(client.rows).toHaveLength(1);
  });

  it("uppercases asset codes on create", async () => {
    const client = new InMemoryIntentLockClient();
    const row = await client.create({
      intentHandle: "intent_1",
      institutionId: "inst",
      assetCode: "usdc",
      amount: 100,
    });
    expect(row.assetCode).toBe("USDC");
  });

  it("rejects duplicate intent handles", async () => {
    const client = new InMemoryIntentLockClient();
    await client.create({
      intentHandle: "intent_1",
      institutionId: "inst",
      assetCode: "USDC",
      amount: 100,
    });

    await expect(
      client.create({
        intentHandle: "intent_1",
        institutionId: "inst",
        assetCode: "USDC",
        amount: 200,
      }),
    ).rejects.toThrow();
    // The original row is still there.
    expect(client.rows).toHaveLength(1);
  });

  it("delete returns true on a present row and false on a missing row", async () => {
    const client = new InMemoryIntentLockClient();
    await client.create({
      intentHandle: "intent_1",
      institutionId: "inst",
      assetCode: "USDC",
      amount: 100,
    });

    expect(await client.delete("intent_1")).toBe(true);
    expect(client.rows).toHaveLength(0);
    expect(await client.delete("intent_1")).toBe(false);
  });

  it("findOlderThan returns rows older than the cutoff, ordered by age", async () => {
    const now = Date.now();
    const client = new InMemoryIntentLockClient([
      {
        intent_handle: "intent_old",
        institution_id: "inst",
        asset_code: "USDC",
        amount: "100",
        correlation_ref: null,
        agent_did: null,
        created_at: new Date(now - 600_000).toISOString(), // 10 min ago
      },
      {
        intent_handle: "intent_fresh",
        institution_id: "inst",
        asset_code: "USDC",
        amount: "200",
        correlation_ref: null,
        agent_did: null,
        created_at: new Date(now - 30_000).toISOString(), // 30s ago
      },
    ]);

    const cutoff = new Date(now - 300_000); // 5 min ago
    const matches = await client.findOlderThan(cutoff);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.intentHandle).toBe("intent_old");
  });

  it("findByInstitution scopes to one institution", async () => {
    const now = new Date().toISOString();
    const client = new InMemoryIntentLockClient([
      {
        intent_handle: "intent_a",
        institution_id: "inst_a",
        asset_code: "USDC",
        amount: "100",
        correlation_ref: null,
        agent_did: null,
        created_at: now,
      },
      {
        intent_handle: "intent_b",
        institution_id: "inst_b",
        asset_code: "USDC",
        amount: "200",
        correlation_ref: null,
        agent_did: null,
        created_at: now,
      },
    ]);

    const matches = await client.findByInstitution("inst_a");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.institutionId).toBe("inst_a");
  });

  it("findByInstitution optionally filters to a single agent", async () => {
    const now = new Date().toISOString();
    const client = new InMemoryIntentLockClient([
      {
        intent_handle: "intent_a",
        institution_id: "inst_a",
        asset_code: "USDC",
        amount: "100",
        correlation_ref: null,
        agent_did: "did:agent:1",
        created_at: now,
      },
      {
        intent_handle: "intent_b",
        institution_id: "inst_a",
        asset_code: "USDC",
        amount: "200",
        correlation_ref: null,
        agent_did: "did:agent:2",
        created_at: now,
      },
    ]);

    const matches = await client.findByInstitution(
      "inst_a",
      "did:agent:1",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.agentDid).toBe("did:agent:1");
  });

  it("seed() bypasses the contract to set up fixtures directly", () => {
    const client = new InMemoryIntentLockClient();
    client.seed({
      intent_handle: "intent_seeded",
      institution_id: "inst",
      asset_code: "USDC",
      amount: "500",
      correlation_ref: null,
      agent_did: null,
      created_at: new Date().toISOString(),
    });
    expect(client.rows).toHaveLength(1);
  });
});
