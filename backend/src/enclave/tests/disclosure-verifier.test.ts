import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import {
  DisallowedNegotiationDisclosureError,
  T3NegotiationDisclosureVerifier,
} from "../negotiation/disclosure-verifier.js";

/**
 * The disclosure verifier is the cryptographic authority on a
 * counterparty claim disclosure. The P0 regression the file used
 * to ship: it stamped a `t3_attestation_ref` synthesized from
 * `Date.now() + randomUUID()` into the negotiation_disclosures
 * row — a value with no cryptographic anchor, no TEE link, and
 * no way for an auditor to correlate it back to the credential
 * the agent actually presented.
 *
 * The post-fix verifier hands the credential to
 * `@terminal3/verify_vc`'s `verifyVc` and derives the
 * attestation ref from (claimType, policyHash, issuer, JWS,
 * SDK message). These tests pin that contract:
 *
 *   1. The T3 SDK's `verifyVc` IS called on a structurally-valid
 *      claim credential and the verifier returns `verified: true`
 *      with a JWS-bound attestation ref.
 *   2. When the SDK returns `isValid: false` (recovered signer
 *      does not match the issuer DID), the verifier fails
 *      closed with `verified: false` and an attestation ref
 *      derived from the (issuer, claimType, policyHash) tuple —
 *      not from `Date.now()`.
 *   3. When the SDK throws (transient outage, malformed proof),
 *      the verifier fails closed the same way. There is no
 *      silent structural downgrade.
 *   4. When the credential lacks a `proof.jws` / `proof.proofValue`
 *      or an `issuer`, the verifier records
 *      `verified: false` with a `missing_proof` discriminator
 *      in the unverified attestation ref so an auditor can
 *      distinguish "no cryptographic evidence exists" from
 *      "cryptographic evidence existed and was rejected".
 *   5. The verified attestation ref is DETERMINISTIC — same
 *      credential + same SDK verdict → same ref — so receipts
 *      can be correlated across rounds.
 *   6. The verified attestation ref CHANGES when the JWS
 *      changes — proving the value is bound to the
 *      cryptographic evidence, not to `Date.now()`.
 */

let verifyVcSpy = vi.fn();

vi.mock("@terminal3/verify_vc", () => ({
  verifyVc: (...args: unknown[]) => verifyVcSpy(...args),
}));

const baseRequest = {
  policyHash: "policy-hash-1",
  claimType: "accredited_institution",
  disclosableClaims: ["accredited_institution", "settlement_capacity"],
};

// Deterministic secp256k1 keypair for the test. The exact bytes
// don't matter — `verifyVcSpy` is mocked so the SDK does not
// actually run cryptographic verification. The keypair is here
// so a hand-crafted credential carries a structurally-valid
// JWS-shaped `proof.jws` string the verifier can read.
const FIXED_SEED = keccak_256(
  new TextEncoder().encode("ghostbroker-disclosure-verifier-test-v1"),
);
const FIXED_PUBLIC_KEY = `0x${[...secp256k1.getPublicKey(FIXED_SEED, true)]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")}`;

// The address derived from the test keypair. The address is
// the EIP-55-checksummed form `ethers.getAddress` returns so
// it matches what `verifyMessage` recovers from the JWS in
// the production wire format.
const ISSUER_DID = "did:ethr:0x" + keccak_256(FIXED_PUBLIC_KEY).slice(-40);

function makeSignedClaimCredential(options: {
  claimType?: string;
  claimValue?: string;
  jws?: string;
  issuer?: string;
  includeProof?: boolean;
  includeIssuer?: boolean;
  includeJws?: boolean;
}): Record<string, unknown> {
  const claimType = options.claimType ?? "accredited_institution";
  const claimValue = options.claimValue ?? "verified-by-accreditor-xyz";
  const jws =
    options.jws ??
    // 65-byte placeholder JWS (the bytes don't matter — the SDK
    // is mocked). The format is "0x" + 130 hex chars.
    "0x" + "ab".repeat(65);
  const issuer = options.issuer ?? ISSUER_DID;
  const credential: Record<string, unknown> = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "urn:uuid:ghostbroker-disclosure-test-1",
    type: ["VerifiableCredential", "GhostBrokerClaimCredential"],
    issuanceDate: "2026-01-01T00:00:00.000Z",
    expirationDate: "2027-01-01T00:00:00.000Z",
    credentialSubject: {
      id: "did:t3n:institution:acme",
      [claimType]: {
        attestedBy: issuer,
        attestedAt: "2026-01-01T00:00:00.000Z",
        digest: createHash("sha256")
          .update(`${issuer}|acme|${claimType}|${claimValue}`)
          .digest("hex"),
        value: claimValue,
      },
    },
  };
  if (options.includeIssuer !== false) {
    credential.issuer = issuer;
  }
  if (options.includeProof !== false) {
    const proof: Record<string, unknown> = {
      type: "EcdsaSecp256k1Signature2019",
      created: "2026-01-01T00:00:00.000Z",
      proofPurpose: "assertionMethod",
      verificationMethod: `${issuer}#key-1`,
    };
    if (options.includeJws !== false) {
      proof.jws = jws;
    }
    credential.proof = proof;
  }
  return credential;
}

beforeEach(() => {
  verifyVcSpy = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T3NegotiationDisclosureVerifier (T3 SDK-backed)", () => {
  it("returns verified=true when @terminal3/verify_vc confirms a signed claim credential", async () => {
    verifyVcSpy = vi.fn().mockResolvedValue({
      isValid: true,
      message: "Verification successful",
    });

    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: makeSignedClaimCredential({}),
    });

    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    expect(result.verified).toBe(true);
    expect(result.claimType).toBe("accredited_institution");
    expect(result.assertionCiphertext).not.toBe("");
    expect(result.t3AttestationRef.startsWith("t3att_")).toBe(true);
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(false);
  });

  it("passes a structurally-correct SignedCredential shape to verifyVc", async () => {
    verifyVcSpy = vi.fn().mockResolvedValue({
      isValid: true,
      message: "verified",
    });

    const verifier = new T3NegotiationDisclosureVerifier();
    const credential = makeSignedClaimCredential({});
    await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: credential,
    });

    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    const callArg = verifyVcSpy.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    // The verifier renamed issuanceDate → validFrom and
    // expirationDate → validUntil (the W3C VC v1.1 field
    // names the SDK hashes).
    expect(callArg.validFrom).toBe(credential.issuanceDate);
    expect(callArg.validUntil).toBe(
      (credential as { expirationDate: string }).expirationDate,
    );
    // The verifier mapped proof.jws → proof.proofValue (the
    // field the SDK hashes).
    expect(callArg.proof.proofValue).toBe(
      (credential.proof as { jws: string }).jws,
    );
    expect(callArg.proof.type).toBe("EcdsaSecp256k1Signature2019");
    expect(callArg.issuer).toBe(ISSUER_DID);
  });

  it("derives the verified attestation ref from (claimType, policyHash, issuer, JWS, SDK message) — not Date.now()", async () => {
    verifyVcSpy = vi.fn().mockResolvedValue({
      isValid: true,
      message: "Verification successful",
    });

    const verifier = new T3NegotiationDisclosureVerifier();
    const credential = makeSignedClaimCredential({});
    const first = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: credential,
    });
    // Same inputs → same attestation ref (no Date.now()/randomUUID).
    const second = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: credential,
    });
    expect(first.t3AttestationRef).toBe(second.t3AttestationRef);
    expect(first.t3AttestationRef).toMatch(/^t3att_[0-9a-f]{32}$/);

    // A different JWS yields a different attestation ref — the
    // value is bound to the cryptographic evidence, not to
    // Date.now() + randomUUID().
    const differentJwsCredential = makeSignedClaimCredential({
      jws: "0x" + "cd".repeat(65),
    });
    const different = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: differentJwsCredential,
    });
    expect(different.t3AttestationRef).not.toBe(first.t3AttestationRef);
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
    // No SDK call should happen when there's no credential at all.
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("returns verified=false when the credential is malformed (not an object)", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: "not-an-object",
    });
    expect(result.verified).toBe(false);
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("returns verified=false when credentialSubject has no assertion for the claim", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: {
        ...makeSignedClaimCredential({ claimType: "accredited_institution" }),
        credentialSubject: { id: "did:t3n:institution:acme" },
      },
    });
    expect(result.verified).toBe(false);
    expect(result.t3AttestationRef).toContain("missing_assertion");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("returns verified=false with the missing_proof discriminator when the credential lacks proof.jws", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: makeSignedClaimCredential({ includeJws: false }),
    });
    expect(result.verified).toBe(false);
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
    expect(result.t3AttestationRef).toContain("missing_proof");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("returns verified=false with the missing_proof discriminator when the credential lacks an issuer", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: makeSignedClaimCredential({ includeIssuer: false }),
    });
    expect(result.verified).toBe(false);
    expect(result.t3AttestationRef).toContain("missing_proof");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("fails closed when verifyVc returns isValid:false (no silent structural downgrade)", async () => {
    verifyVcSpy = vi.fn().mockResolvedValue({
      isValid: false,
      message: "Signature does not correspond to verificationMethod",
    });

    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: makeSignedClaimCredential({}),
    });

    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    expect(result.verified).toBe(false);
    expect(result.assertionCiphertext).toBe("");
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
  });

  it("fails closed when verifyVc throws (no silent structural downgrade)", async () => {
    verifyVcSpy = vi.fn().mockRejectedValue(
      new Error("Unsupported DID method: t3n"),
    );

    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: makeSignedClaimCredential({}),
    });

    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    expect(result.verified).toBe(false);
    expect(result.assertionCiphertext).toBe("");
    expect(result.t3AttestationRef.startsWith("t3att_unverified_")).toBe(true);
  });

  it("throws DisallowedNegotiationDisclosureError when the claim is not on the allowlist", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    await expect(
      verifier.verifyDisclosure({
        ...baseRequest,
        claimType: "not_on_allowlist",
        claimCredential: makeSignedClaimCredential({
          claimType: "not_on_allowlist",
        }),
      }),
    ).rejects.toBeInstanceOf(DisallowedNegotiationDisclosureError);
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("accepts non-string assertion values (booleans, objects) when the credentialSubject contains them", async () => {
    verifyVcSpy = vi.fn().mockResolvedValue({
      isValid: true,
      message: "Verification successful",
    });

    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      ...baseRequest,
      claimCredential: {
        ...makeSignedClaimCredential({}),
        credentialSubject: {
          id: "did:t3n:institution:acme",
          accredited_institution: {
            tier: "tier1",
            attestedAt: "2026-01-01",
          },
        },
      },
    });
    expect(result.verified).toBe(true);
  });
});
