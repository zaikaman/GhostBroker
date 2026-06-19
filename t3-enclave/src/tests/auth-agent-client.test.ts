import { describe, expect, it } from "vitest";
import { GhostbrokerDelegationAgentAuthClient } from "../auth/agent-auth-client.js";

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
    allowedActions: ["agent.admit"],
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
    const client = new GhostbrokerDelegationAgentAuthClient();

    await expect(client.verifyDelegation(baseRequest)).resolves.toEqual({
      status: "verified",
      agentDid: baseRequest.agentDid,
      authorityRef: baseRequest.authorityRef,
      policyHash:
        "ce3b08cb992446501f996876ef99c9b1df7bff343186555495966dbf3a3725ec",
    });
  });

  it("produces a stable sha256 policy hash for the same VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

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
    const client = new GhostbrokerDelegationAgentAuthClient();

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
    const client = new GhostbrokerDelegationAgentAuthClient();

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

  it("rejects a VC with a procurement purchase-category scope (legacy shape)", async () => {
    // The procurement BUIDL enum
    // (`office-supplies | software | hardware | services | travel`)
    // is no longer a valid scope on a GhostBroker trading-agent
    // delegation VC. The verifier must reject it as `malformed`
    // so a stale dashboard snapshot can never re-introduce a
    // procurement-style grant to a trading agent.
    const client = new GhostbrokerDelegationAgentAuthClient();
    // Replace `allowedActions` (the trading-agent action
    // scope) with the legacy procurement `allowedCategories`.
    // The verifier's `ghostbrokerDelegationSchema` requires
    // `allowedActions` to be a non-empty array of the
    // `DelegationActionScope` enum, so the absence of
    // `allowedActions` fails the schema parse.
    const { allowedActions: _omit, ...legacySubject } =
      vc.credentialSubject;
    void _omit;
    const procurementVc = {
      ...vc,
      credentialSubject: {
        ...legacySubject,
        allowedCategories: ["software", "travel"],
      },
    };

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        delegationCredential: procurementVc,
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "malformed",
    });
  });
});
