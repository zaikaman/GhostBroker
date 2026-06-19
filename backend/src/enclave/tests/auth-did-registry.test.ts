import { describe, expect, it } from "vitest";
import { AdkTenantDidRegistry } from "../auth/did-registry.js";
import type { T3NetworkClient, T3NetworkRequest } from "../sandbox/t3n-client.js";

class RecordingClient implements T3NetworkClient {
  public readonly requests: T3NetworkRequest[] = [];

  public constructor(private readonly statuses: readonly number[]) {}

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<{ status: number; body: TBody }> {
    this.requests.push(request);
    const status = this.statuses[this.requests.length - 1] ?? 200;
    return {
      status,
      body: { tenantDid: "did:t3n:tenant:resolved" } as TBody,
    };
  }
}

describe("T3 tenant DID registry", () => {
  it("uses the authenticated session DID when available", async () => {
    const client = new RecordingClient([200]);
    const registry = new AdkTenantDidRegistry(client);

    await expect(
      registry.resolveOrRegisterTenantDid({
        legalName: "Northstar Capital Markets LLC",
        displayName: "Northstar Capital",
        settlementProfileRef: "settlement-profile:northstar:test",
      }),
    ).resolves.toEqual({
      tenantDid: "did:t3n:tenant:resolved",
      source: "existing_session",
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.path).toBe("/tenant/session/resolve");
  });

  it("registers a tenant when the session has no DID", async () => {
    const client = new RecordingClient([404, 201]);
    const registry = new AdkTenantDidRegistry(client);

    const result = await registry.resolveOrRegisterTenantDid({
      legalName: "Northstar Capital Markets LLC",
      displayName: "Northstar Capital",
      settlementProfileRef: "settlement-profile:northstar:test",
    });

    expect(result.source).toBe("registered");
    expect(client.requests.map((item) => item.path)).toEqual([
      "/tenant/session/resolve",
      "/tenant/register",
    ]);
  });
});
