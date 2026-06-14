import { describe, expect, it } from "vitest";
import { verifyDelegationCredential } from "./vc-verifier.js";
import type { DelegationCredential } from "./delegation.js";

const sandboxVc: DelegationCredential = {
  id: "urn:uuid:test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000001",
  issuanceDate: "2026-01-01T00:00:00Z",
  expirationDate: "2027-01-01T00:00:00Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000001",
    agentDid: "did:t3n:0xagent",
    maxSpendUsd: 500,
    allowedCategories: ["office-supplies"],
    purpose: "test",
  },
  proof: {
    type: "JsonWebSignature2020",
    created: "2026-01-01T00:00:00Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000001#key-1",
    jws: "live-demo-unsigned",
  },
};

describe("verifyDelegationCredential (boundbuyer flow)", () => {
  it("accepts a demo-proof VC in sandbox mode", async () => {
    const result = await verifyDelegationCredential(sandboxVc, "did:t3n:0xagent", "sandbox");
    expect(result.verified).toBe(true);
    expect(result.mode).toBe("sandbox");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects an expired VC", async () => {
    const expired = { ...sandboxVc, expirationDate: "2020-01-01T00:00:00Z" };
    const result = await verifyDelegationCredential(expired, "did:t3n:0xagent", "sandbox");
    expect(result.verified).toBe(false);
  });

  it("rejects an agent DID mismatch", async () => {
    const result = await verifyDelegationCredential(
      sandboxVc,
      "did:t3n:0xsomebody-else",
      "sandbox",
    );
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/agent/i);
  });

  it("rejects demo proof in live mode", async () => {
    const result = await verifyDelegationCredential(sandboxVc, "did:t3n:0xagent", "live");
    expect(result.verified).toBe(false);
  });

  it("accepts demo proof in structural mode", async () => {
    const result = await verifyDelegationCredential(
      sandboxVc,
      "did:t3n:0xagent",
      "structural",
    );
    expect(result.verified).toBe(true);
    expect(result.mode).toBe("structural");
  });
});
