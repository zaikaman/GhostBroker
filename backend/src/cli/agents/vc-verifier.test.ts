import { describe, expect, it } from "vitest";
import { verifyDelegationCredential } from "./vc-verifier.js";
import type { DelegationCredential } from "./delegation.js";

/**
 * The verifier runs in `live` mode exclusively. It accepts
 * a structurally valid, cryptographically signed
 * `EcdsaSecp256k1Signature2019` VC, or rejects with
 * `verified: false` on any shape, time-window, or
 * crypto-verification failure.
 *
 * The legacy three-mode design (`sandbox` / `structural` /
 * `live`) has been collapsed. The mode parameter has been
 * removed from the public `verifyDelegationCredential`
 * signature; the only mode the verifier supports is `live`.
 */

const liveVc: DelegationCredential = {
  id: "urn:uuid:test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000001",
  issuanceDate: "2026-01-01T00:00:00Z",
  expirationDate: "2027-01-01T00:00:00Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000001",
    agentDid: "did:t3n:0xagent",
    maxSpendUsd: 500,
    allowedActions: ["agent.admit", "intent.submit"],
    purpose: "test",
  },
  proof: {
    type: "EcdsaSecp256k1Signature2019",
    created: "2026-01-01T00:00:00Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000001#key-1",
    jws: "0x" + "ab".repeat(64) + "1b",
  },
};

describe("verifyDelegationCredential (Ghostbroker delegation flow)", () => {
  it("rejects an expired VC", async () => {
    const expired = { ...liveVc, expirationDate: "2020-01-01T00:00:00Z" };
    const result = await verifyDelegationCredential(expired, "did:t3n:0xagent");
    expect(result.verified).toBe(false);
    expect(result.mode).toBe("live");
    expect(result.message).toMatch(/expired/i);
  });

  it("rejects an agent DID mismatch", async () => {
    const result = await verifyDelegationCredential(
      liveVc,
      "did:t3n:0xsomebody-else",
    );
    expect(result.verified).toBe(false);
    expect(result.mode).toBe("live");
    expect(result.message).toMatch(/agent/i);
  });

  it("rejects a VC with no proof on the live crypto path", async () => {
    // Without a proof.jws the verifier falls through to the
    // @terminal3/verify_vc call which throws, the verifier
    // catches it, and returns verified: false. The mode is
    // always "live" on every result path.
    const noProof: DelegationCredential = {
      ...liveVc,
      proof: undefined,
    };
    const result = await verifyDelegationCredential(noProof, "did:t3n:0xagent");
    expect(result.verified).toBe(false);
    expect(result.mode).toBe("live");
  });

  it("always reports mode=live on any result", async () => {
    // The verifier's only mode is `live`. Every result -
    // verified, expired, agent-mismatch, crypto-failed -
    // surfaces mode "live" on the result struct.
    const expired = { ...liveVc, expirationDate: "2020-01-01T00:00:00Z" };
    const expiredResult = await verifyDelegationCredential(expired, "did:t3n:0xagent");
    expect(expiredResult.mode).toBe("live");

    const mismatchResult = await verifyDelegationCredential(
      liveVc,
      "did:t3n:0xsomebody-else",
    );
    expect(mismatchResult.mode).toBe("live");

    const cryptoResult = await verifyDelegationCredential(liveVc, "did:t3n:0xagent");
    expect(cryptoResult.mode).toBe("live");
  });
});
