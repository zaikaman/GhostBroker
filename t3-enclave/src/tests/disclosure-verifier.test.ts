import { describe, expect, it } from "vitest";
import {
  DisallowedNegotiationDisclosureError,
  T3NegotiationDisclosureVerifier,
} from "../negotiation/disclosure-verifier.js";

const baseRequest = {
  policyHash: "policy-hash-1",
  claimType: "accredited_institution",
  disclosableClaims: ["accredited_institution", "settlement_capacity"],
};

describe("T3NegotiationDisclosureVerifier", () => {
  it("returns verified=true when the credential asserts the claim", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: {
        credentialSubject: {
          accredited_institution: "verified-by-accreditor-xyz",
        },
      },
    });
    expect(result.verified).toBe(true);
    expect(result.claimType).toBe("accredited_institution");
    expect(result.assertionCiphertext).not.toBe("");
    expect(result.t3AttestationRef.startsWith("t3att_")).toBe(true);
  });

  it("returns verified=false (does NOT throw) when no credential is supplied", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      // claimCredential intentionally omitted
    });
    expect(result.verified).toBe(false);
    expect(result.claimType).toBe("accredited_institution");
    expect(result.assertionCiphertext).toBe("");
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
  });

  it("returns verified=false when the credential is malformed", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: "not-an-object",
    });
    expect(result.verified).toBe(false);
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
  });

  it("returns verified=false when credentialSubject has no assertion for the claim", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: {
        credentialSubject: {
          some_other_claim: "yes",
        },
      },
    });
    expect(result.verified).toBe(false);
  });

  it("throws DisallowedNegotiationDisclosureError when the claim is not on the allowlist", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    await expect(
      verifier.verifyDisclosure({
        ...baseRequest,
        claimType: "not_on_allowlist",
        claimCredential: {
          credentialSubject: { not_on_allowlist: "yes" },
        },
      }),
    ).rejects.toBeInstanceOf(DisallowedNegotiationDisclosureError);
  });

  it("accepts non-string assertion values (booleans, objects)", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: {
        credentialSubject: {
          accredited_institution: { tier: "tier1", attestedAt: "2026-01-01" },
        },
      },
    });
    expect(result.verified).toBe(true);
  });
});
