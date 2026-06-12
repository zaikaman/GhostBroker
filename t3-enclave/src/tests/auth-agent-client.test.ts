import { describe, expect, it } from "vitest";
import { DashboardDelegationAgentAuthClient } from "../auth/agent-auth-client.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

class DelegationClient implements T3NetworkClient {
  public constructor(
    private readonly status: number,
    private readonly body: unknown,
  ) {}

  public async request<TBody = unknown>(): Promise<{
    status: number;
    body: TBody;
  }> {
    return { status: this.status, body: this.body as TBody };
  }
}

const request = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:agent:us1-authorized",
  authorityProof: "proof:dashboard-grant",
  requestedAction: "agent.admit" as const,
};

describe("T3 agent delegation adapter", () => {
  it("accepts dashboard-provisioned grants returned by Terminal 3", async () => {
    const client = new DashboardDelegationAgentAuthClient(
      new DelegationClient(200, {
        status: "verified",
        agentDid: request.agentDid,
        authorityRef: "authority:verified",
        policyHash: "policy:verified",
      }),
    );

    await expect(client.verifyDelegation(request)).resolves.toEqual({
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: "authority:verified",
      policyHash: "policy:verified",
    });
  });

  it("passes through programmatic rejection reasons when available", async () => {
    const client = new DashboardDelegationAgentAuthClient(
      new DelegationClient(200, {
        status: "rejected",
        agentDid: request.agentDid,
        reason: "revoked",
      }),
    );

    await expect(client.verifyDelegation(request)).resolves.toEqual({
      status: "rejected",
      agentDid: request.agentDid,
      reason: "revoked",
    });
  });

  it("fails closed when grant verification is unavailable", async () => {
    const client = new DashboardDelegationAgentAuthClient(
      new DelegationClient(503, { code: "service_unavailable" }),
    );

    await expect(client.verifyDelegation(request)).resolves.toEqual({
      status: "rejected",
      agentDid: request.agentDid,
      reason: "unverified",
    });
  });
});
