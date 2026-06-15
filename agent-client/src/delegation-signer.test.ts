import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { verifyMessage, Wallet } from "ethers";
import {
  buildDelegationSigningBody,
  canonicalizeDelegationJson,
  delegationCredentialSchema,
  mintAndSignDelegationCredential,
  mintDelegationCredentialBody,
  signDelegationCredential,
} from "./delegation-signer.js";

/**
 * Tests for the browser-safe W3C VC delegation signer.
 *
 * The critical contract: a credential produced here, fed to
 * the backend's `verifyEcdsaVc` (which calls
 * `ethers.verifyMessage` internally), recovers an address
 * that matches the issuer DID. That round-trip is what
 * makes the `T3_MODE=live` path production-ready.
 */
describe("delegation-signer", () => {
  // Deterministic secp256k1 keypair for the test.
  const FIXED_SEED = keccak_256(
    new TextEncoder().encode("ghostbroker-delegation-signer-test-v1"),
  );
  const FIXED_PRIVATE_KEY = `0x${[
    ...FIXED_SEED,
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
  const FIXED_PUBLIC_KEY = `0x${[
    ...secp256k1.getPublicKey(FIXED_SEED, true),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;

  it("buildDelegationSigningBody renames issuanceDate→validFrom, expirationDate→validUntil, strips proof", () => {
    const credential = mintDelegationCredentialBody({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
    });
    const body = buildDelegationSigningBody(credential);
    expect(body).not.toHaveProperty("issuanceDate");
    expect(body).not.toHaveProperty("expirationDate");
    expect(body).not.toHaveProperty("proof");
    expect(body.validFrom).toBe(credential.issuanceDate);
    expect(body.validUntil).toBe(credential.expirationDate);
  });

  it("canonicalizeDelegationJson sorts keys recursively", () => {
    const obj = { z: 1, a: { y: 2, x: 3 }, m: [{ q: 4, p: 5 }] };
    expect(canonicalizeDelegationJson(obj)).toBe(
      '{"a":{"x":3,"y":2},"m":[{"p":5,"q":4}],"z":1}',
    );
  });

  it("signDelegationCredential produces an EcdsaSecp256k1Signature2019 JWS", () => {
    const credential = mintDelegationCredentialBody({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
    });
    const signed = signDelegationCredential(credential, {
      privateKey: FIXED_PRIVATE_KEY,
      publicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
    });
    expect(signed.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(signed.proof?.proofPurpose).toBe("assertionMethod");
    expect(signed.proof?.verificationMethod).toBe("did:t3n:0xsigner#key-1");
    expect(signed.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);
    // Round-trip through the zod schema
    expect(() => delegationCredentialSchema.parse(signed)).not.toThrow();
  });

  it("signed JWS is verifiable by ethers (EIP-191 personal_sign)", () => {
    const credential = mintDelegationCredentialBody({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 5_000,
    });
    const signed = signDelegationCredential(credential, {
      privateKey: FIXED_PRIVATE_KEY,
      publicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
    });

    // Reproduce the byte-level flow that
    // `@terminal3/verify_vc`'s `verifyEcdsaVc` runs:
    //   1. canonicalize body
    //   2. keccak256(utf-8 bytes)  →  32-byte digest
    //   3. ethers.verifyMessage(digest, sig)  →  recovered address
    // The address must equal the wallet address derived from
    // the signing key.
    const body = buildDelegationSigningBody(credential);
    const canonical = canonicalizeDelegationJson(body);
    const hash = keccak_256(new TextEncoder().encode(canonical));
    const sig = signed.proof?.jws as `0x${string}`;

    const wallet = new Wallet(FIXED_PRIVATE_KEY);
    const recovered = verifyMessage(new Uint8Array(hash), sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("mintAndSignDelegationCredential mints and signs in one call", () => {
    const signed = mintAndSignDelegationCredential({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 2_500,
      issuerPrivateKey: FIXED_PRIVATE_KEY,
      issuerPublicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
    });
    expect(signed.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(signed.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects a 31-byte (too-short) private key", () => {
    // "0x" + 62 hex chars = 64 chars total, not the required 66.
    const short = "0x" + "ab".repeat(31);
    const credential = mintDelegationCredentialBody({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 100,
    });
    expect(() =>
      signDelegationCredential(credential, {
        privateKey: short,
        publicKey: FIXED_PUBLIC_KEY,
        issuerDid: "did:t3n:0xsigner",
      }),
    ).toThrow(/signing key must be a 0x-prefixed 32-byte hex/);
  });

  it("rejects a 65-byte (uncompressed) public key", () => {
    // 0x + 130 hex chars = 132 chars, not the required 68. We
    // exercise the "wrong length" branch — the byte-length
    // branch is structurally the same check, just a more
    // specific failure.
    const longPubKey = ("0x" + "ab".repeat(65)) as `0x${string}`;
    const credential = mintDelegationCredentialBody({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 100,
    });
    expect(() =>
      signDelegationCredential(credential, {
        privateKey: FIXED_PRIVATE_KEY,
        publicKey: longPubKey,
        issuerDid: "did:t3n:0xsigner",
      }),
    ).toThrow(/expected public key must be a 0x-prefixed 33-byte compressed/);
  });
});
