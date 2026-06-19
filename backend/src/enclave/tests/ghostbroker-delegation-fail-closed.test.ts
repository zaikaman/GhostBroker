/**
 * Fail-closed semantics for the production authority gate.
 *
 * The verifier is the single source of truth for agent
 * authority — every privileged backend action
 * (`submitIntent`, `cancelIntent`, `settlement.execute`,
 * `negotiation.*`) re-runs it on the persisted VC. A
 * security-critical verifier that defaults to "verified on
 * SDK error" is an attack surface for any adversarial T3
 * SDK version bump or transient SDK outage. The verifier
 * fails closed on any `@terminal3/verify_vc` exception.
 *
 * The verifier runs in `live` mode exclusively — there is
 * no longer a `sandbox` demo surface to tolerate SDK
 * errors in, and no `structural` mode to silently downgrade
 * to on a crypto failure.
 *
 * The tests in this file mock `@terminal3/verify_vc` at the
 * module level (hoisted `vi.mock`) so the SDK throws
 * deterministically. The verifier is required to return
 * `rejected` / `unverified` (never a silent `verified`).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@terminal3/verify_vc", () => ({
  verifyVc: async () => {
    throw new Error("simulated SDK outage");
  },
}));

const { verifyGhostbrokerDelegationCredential } = await import(
  "../auth/ghostbroker-delegation.js"
);

const baseRequest = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:agent:us1-authorized",
  requestedAction: "agent.admit" as const,
};

// A well-formed (but cryptographically meaningless) 65-byte
// EIP-191 JWS. The verifier will reach the crypto path
// because the JWS is structurally valid.
const signedVc = {
  id: "urn:uuid:ghostbroker-delegation-test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000099",
  issuanceDate: "2026-01-01T00:00:00.000Z",
  expirationDate: "2027-01-01T00:00:00.000Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000099",
    agentDid: "did:t3n:agent:us1-authorized",
    maxSpendUsd: 1000,
    allowedActions: ["agent.admit", "intent.submit"],
    purpose: "test",
  },
  proof: {
    type: "EcdsaSecp256k1Signature2019",
    created: "2026-01-01T00:00:00.000Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000099#key-1",
    jws: "0x" + "ab".repeat(64) + "1b",
  },
};

describe("verifyGhostbrokerDelegationCredential fail-closed semantics", () => {
  it("fails closed when @terminal3/verify_vc throws (no silent structural downgrade)", async () => {
    const result = await verifyGhostbrokerDelegationCredential({
      ...baseRequest,
      credential: signedVc,
    });

    expect(result.status).toBe("rejected");
    if (result.status === "verified") {
      throw new Error(
        "unreachable: the live verifier must never report `verified` on an SDK error",
      );
    }
    expect(result.reason).toBe("unverified");
  });

  it("never reports `verified` with a non-live mode on an SDK error", async () => {
    // Pin the post-fix contract: with the three-mode design
    // gone, the verifier no longer emits a
    // `verificationMode: "structural"` value on an SDK throw.
    // The only emitted `verificationMode` is `"live"`, and
    // it is only emitted on a successful verification.
    const result = await verifyGhostbrokerDelegationCredential({
      ...baseRequest,
      credential: signedVc,
    });
    if (result.status === "verified") {
      throw new Error(
        "unreachable: SDK error must never produce a verified result",
      );
    }
    expect(result).toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "unverified",
    });
  });
});
