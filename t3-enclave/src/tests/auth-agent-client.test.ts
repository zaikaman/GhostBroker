import { describe, expect, it } from "vitest";
import { GhostbrokerDelegationAgentAuthClient } from "../auth/agent-auth-client.js";
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

const vc = {
  id: "urn:uuid:ghostbroker-delegation-test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000099",
  issuanceDate: "2026-01-01T00:00:00.000Z",
  expirationDate: "2027-01-01T00:00:00.000Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000099",
    agentDid: "did:t3n:agent:us1-authorized",
    maxSpendUsd: 1000,
    allowedCategories: ["software"],
    purpose: "test",
  },
  proof: {
    type: "JsonWebSignature2020",
    created: "2026-01-01T00:00:00.000Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000099#key-1",
    jws: "live-demo-unsigned",
  },
};

const baseRequest = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:agent:us1-authorized",
  authorityRef: "ghostbroker-delegation:urn:uuid:ghostbroker-delegation-test",
  requestedAction: "agent.admit" as const,
  delegationCredential: vc,
};

describe("T3 agent delegation adapter", () => {
  it("accepts Ghostbroker-style delegation VCs", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient(
      new DelegationClient(200, { status: "verified" }),
    );

    await expect(client.verifyDelegation(baseRequest)).resolves.toEqual({
      status: "verified",
      agentDid: baseRequest.agentDid,
      authorityRef: baseRequest.authorityRef,
      policyHash:
        "7b88a2ae04139e3ed85f17567a4b7c27a38933ecbbb04067cd106620488bf146",
    });
  });

  it("produces a stable sha256 policy hash for the same VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient(
      new DelegationClient(200, { status: "verified" }),
    );

    const first = await client.verifyDelegation(baseRequest);
    const second = await client.verifyDelegation(baseRequest);
    const hex64 = /^[0-9a-f]{64}$/u;

    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    if (first.status !== "verified" || second.status !== "verified") {
      throw new Error("unreachable: expected verified status");
    }
    expect(first.policyHash).toBe(second.policyHash);
    expect(first.policyHash).toMatch(hex64);
  });

  it("rejects a stale authorityRef that does not match the VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient(
      new DelegationClient(200, { status: "verified" }),
    );

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        authorityRef: "ghostbroker-delegation:urn:uuid:different-credential",
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "over_scoped",
    });
  });

  it("rejects an expired VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient(
      new DelegationClient(200, { status: "verified" }),
    );

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        delegationCredential: {
          ...vc,
          expirationDate: "2024-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "expired",
    });
  });
});
