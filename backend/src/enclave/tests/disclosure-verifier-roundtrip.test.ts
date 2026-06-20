import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVc } from "@terminal3/verify_vc";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ethers } from "ethers";
import {
  DisallowedNegotiationDisclosureError,
  T3NegotiationDisclosureVerifier,
} from "../negotiation/disclosure-verifier.js";

/**
 * The verifier's `toSignedCredential` shapes the agent's wire
 * credential into the `SignedCredential` `@terminal3/verify_vc`
 * expects. The byte-level JSON the SDK hashes (`body` minus
 * `proof`) MUST match what the agent's signer hashed at sign
 * time — otherwise the recovered signer address won't match
 * `proof.verificationMethod` and the SDK reports "Signature
 * does not correspond to verificationMethod in the proof".
 *
 * These tests pin that contract end-to-end: a real JWS produced
 * by `signEcdsaVcBody` on a real compressed secp256k1 keypair
 * must round-trip through the verifier's `toSignedCredential`
 * transform AND `verifyVc` with `isValid: true`.
 */

let verifyVcSpy = vi.fn();

vi.mock("@terminal3/verify_vc", async () => {
  const actual = await vi.importActual<typeof import("@terminal3/verify_vc")>(
    "@terminal3/verify_vc",
  );
  return {
    ...actual,
    verifyVc: (...args: unknown[]) => verifyVcSpy(...args),
  };
});

function freshKeypair(): { privateKey: string; publicKey: string; issuerDid: string } {
  const seed = keccak_256(
    new TextEncoder().encode(
      `disclosure-verifier-roundtrip-${Date.now()}-${Math.random()}`,
    ),
  );
  const privateKey = `0x${Buffer.from(seed).toString("hex")}`;
  const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(seed, true)).toString("hex")}`;
  const keyBytes = new Uint8Array(Buffer.from(privateKey.slice(2), "hex"));
  const pubKey = secp256k1.getPublicKey(keyBytes, false);
  const hash = keccak_256(pubKey.slice(1));
  const raw = "0x" + Buffer.from(hash.slice(12)).toString("hex");
  // EIP-55-normalize the issuer address — the SDK's case-sensitive
  // `verificationMethod.includes(recoveredAddress)` check requires
  // the DID's address to be in EIP-55 form (matching the form
  // `ethers.verifyMessage` returns).
  const issuerDid = `did:ethr:${ethers.getAddress(raw)}`;
  return { privateKey, publicKey, issuerDid };
}

beforeEach(() => {
  verifyVcSpy = vi.fn().mockImplementation(async (vc) => {
    const actual = vi.importActual("@terminal3/verify_vc" as never) as Promise<{
      verifyVc: typeof verifyVc;
    }>;
    const mod = await actual;
    return mod.verifyVc(vc as Parameters<typeof verifyVc>[0]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T3NegotiationDisclosureVerifier — SDK round-trip", () => {
  it("accepts a VC whose @context already includes the W3C v1 URL (no duplication)", async () => {
    const { privateKey, publicKey, issuerDid } = freshKeypair();
    // Use a generous expiry window so the SDK's `validUntil` check
    // doesn't reject the credential before the signature path
    // runs. The expiration check is a separate SDK layer (not the
    // signature check we're pinning here).
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    // What the agent's signing body looks like.
    const signingBody = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "urn:uuid:ghostbroker-claim-roundtrip",
      type: ["VerifiableCredential", "GhostBrokerClaimCredential"],
      issuer: issuerDid,
      validFrom: issuedAt,
      validUntil: expiresAt,
      credentialSubject: {
        id: "Test Institution",
        accredited_institution: { value: "self-attested" },
      },
    };

    // Sign with the production signer.
    const { signEcdsaVcBody } = await import(
      "../../sdk/agent-client/delegation-signer.js"
    );
    const proof = signEcdsaVcBody({
      body: signingBody,
      issuerDid,
      signerPrivateKey: privateKey,
      signerPublicKey: publicKey,
      created: issuedAt,
    });

    // The wire credential the agent posts to the backend uses
    // the legacy `issuanceDate` / `expirationDate` names so the
    // existing `toSignedCredential` rename is exercised.
    const wireCredential = {
      "@context": [...signingBody["@context"]],
      id: signingBody.id,
      type: [...signingBody.type],
      issuer: signingBody.issuer,
      issuanceDate: signingBody.validFrom,
      expirationDate: signingBody.validUntil,
      credentialSubject: { ...signingBody.credentialSubject },
      proof,
    };

    const verifier = new T3NegotiationDisclosureVerifier();
    const result = await verifier.verifyDisclosure({
      policyHash: "policy-hash-roundtrip",
      claimType: "accredited_institution",
      disclosableClaims: ["accredited_institution"],
      claimCredential: wireCredential,
    });

    // Sanity: the verifier's transform must not change the
    // @context URL byte sequence (the URL was already present).
    expect(result.verified).toBe(true);
    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    const callArg = verifyVcSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg["@context"]).toEqual([
      "https://www.w3.org/2018/credentials/v1",
    ]);
  });

  it("still appends the W3C v1 URL when the agent's @context omits it", async () => {
    // Edge case: a future agent version might send a credential
    // without the W3C v1 URL. The verifier's dedup logic should
    // append it once (the SDK requires it), not duplicate an
    // existing entry.
    const { privateKey, publicKey, issuerDid } = freshKeypair();
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    // Sign with a minimal context (no W3C v1 URL).
    const signingBody = {
      "@context": ["https://example.org/custom/v1"],
      id: "urn:uuid:ghostbroker-claim-min",
      type: ["VerifiableCredential"],
      issuer: issuerDid,
      validFrom: issuedAt,
      validUntil: expiresAt,
      credentialSubject: {
        id: "Test Institution",
        accredited_institution: { value: "self-attested" },
      },
    };
    const { signEcdsaVcBody } = await import(
      "../../sdk/agent-client/delegation-signer.js"
    );
    const proof = signEcdsaVcBody({
      body: signingBody,
      issuerDid,
      signerPrivateKey: privateKey,
      signerPublicKey: publicKey,
      created: issuedAt,
    });

    const wireCredential = {
      "@context": [...signingBody["@context"]],
      id: signingBody.id,
      type: [...signingBody.type],
      issuer: signingBody.issuer,
      issuanceDate: signingBody.validFrom,
      expirationDate: signingBody.validUntil,
      credentialSubject: { ...signingBody.credentialSubject },
      proof,
    };

    const verifier = new T3NegotiationDisclosureVerifier();
    await verifier.verifyDisclosure({
      policyHash: "policy-hash-min",
      claimType: "accredited_institution",
      disclosableClaims: ["accredited_institution"],
      claimCredential: wireCredential,
    });

    expect(verifyVcSpy).toHaveBeenCalledTimes(1);
    const callArg = verifyVcSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg["@context"]).toEqual([
      "https://example.org/custom/v1",
      "https://www.w3.org/2018/credentials/v1",
    ]);
  });

  it("throws DisallowedNegotiationDisclosureError when the claim is not on the allowlist", async () => {
    const verifier = new T3NegotiationDisclosureVerifier();
    await expect(
      verifier.verifyDisclosure({
        policyHash: "policy-hash-allowlist",
        claimType: "not_on_allowlist",
        disclosableClaims: ["accredited_institution"],
      }),
    ).rejects.toBeInstanceOf(DisallowedNegotiationDisclosureError);
  });
});