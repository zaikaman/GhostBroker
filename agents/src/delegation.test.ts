import { describe, expect, it } from "vitest";
import {
  isDelegationActive,
  loadDelegationCredential,
  mintAndSignDelegationCredential,
  mintDelegationCredential,
  signDelegationCredential,
} from "./delegation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Wallet, verifyMessage } from "ethers";

describe("delegation credential minting/loading", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-delegation-test-"));

  it("mints a structurally-valid VC", () => {
    const { path, credential } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "mint.json"),
    });
    expect(path).toBe(join(tmp, "mint.json"));
    expect(credential.id).toMatch(/^urn:uuid:ghostbroker-delegation-/);
    expect(credential.credentialSubject.agentDid).toBe("did:t3n:0xagent");
    expect(credential.credentialSubject.maxSpendUsd).toBe(1_000);
  });

  it("loads back the minted VC through the zod schema", () => {
    const { path } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "roundtrip.json"),
    });
    const loaded = loadDelegationCredential(path);
    expect(loaded.credentialSubject.agentDid).toBe("did:t3n:0xagent");
  });

  it("rejects an unknown purchase category", () => {
    const badPath = join(tmp, "bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        id: "urn:uuid:bad",
        type: ["VerifiableCredential", "GhostBrokerDelegation"],
        issuer: "did:t3n:0x0000000000000000000000000000000000000001",
        issuanceDate: "2026-01-01T00:00:00Z",
        expirationDate: "2027-01-01T00:00:00Z",
        credentialSubject: {
          id: "did:t3n:0x0000000000000000000000000000000000000001",
          agentDid: "did:t3n:0xagent",
          maxSpendUsd: 1_000,
          allowedCategories: ["weapons"], // not in the enum
          purpose: "test",
        },
      }),
      "utf8",
    );
    expect(() => loadDelegationCredential(badPath)).toThrow();
  });

  it("isDelegationActive is true within the window and false outside", () => {
    const { path } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "active.json"),
    });
    const loaded = loadDelegationCredential(path);
    expect(isDelegationActive(loaded, new Date("2026-06-15T00:00:00Z"))).toBe(true);
    expect(isDelegationActive(loaded, new Date("2020-01-01T00:00:00Z"))).toBe(false);
  });

  // Cleanup
  it("cleanup tmp dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("delegation credential signing (EIP-191 / EcdsaSecp256k1Signature2019)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-sign-test-"));

  // Deterministic secp256k1 keypair for the test. Drawn
  // from a fixed seed string so the test is reproducible
  // without a fixture file.
  const FIXED_SEED = keccak_256(
    new TextEncoder().encode("ghostbroker-sign-test-v1"),
  );
  const FIXED_PRIVATE_KEY = `0x${Buffer.from(FIXED_SEED).toString("hex")}` as `0x${string}`;
  const FIXED_PUBLIC_KEY = `0x${Buffer.from(
    secp256k1.getPublicKey(FIXED_SEED, true),
  ).toString("hex")}` as `0x${string}`;

  it("signDelegationCredential produces an EcdsaSecp256k1Signature2019 JWS", () => {
    const { credential } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "unsigned.json"),
    });
    expect(credential.proof).toBeUndefined();

    const signed = signDelegationCredential(credential, {
      privateKey: FIXED_PRIVATE_KEY,
      publicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
    });

    expect(signed.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(signed.proof?.proofPurpose).toBe("assertionMethod");
    expect(signed.proof?.verificationMethod).toBe("did:t3n:0xsigner#key-1");
    expect(signed.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signed JWS is verifiable by ethers (EIP-191 personal_sign)", () => {
    // The @terminal3/verify_vc verifier recovers the address
    // via `ethers.verifyMessage(hash, sig)`, where hash is the
    // keccak256 of the canonical JSON body (no proof field).
    // Reproduce that exact path in the test so we know the
    // signer output is byte-identical to what the verifier
    // will see.
    const { credential } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 5_000,
      outputPath: join(tmp, "unsigned-verify.json"),
    });
    const signed = signDelegationCredential(credential, {
      privateKey: FIXED_PRIVATE_KEY,
      publicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
    });

    // Compute the body hash the same way the signer does:
    //   1. canonicalize body (sorted keys, no whitespace)
    //   2. keccak256 of utf-8 bytes
    // The body the signer uses is the VC with proof stripped
    // and `issuanceDate` / `expirationDate` renamed to
    // `validFrom` / `validUntil`.
    const body = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: credential.id,
      type: credential.type,
      issuer: credential.issuer,
      validFrom: credential.issuanceDate,
      validUntil: credential.expirationDate,
      credentialSubject: { ...credential.credentialSubject },
    };
    const canonical = (function sort(v: unknown): string {
      if (v === null || typeof v !== "object") return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(sort).join(",")}]`;
      const e = Object.entries(v as Record<string, unknown>).sort(
        ([a], [b]) => a.localeCompare(b),
      );
      return `{${e.map(([k, c]) => `${JSON.stringify(k)}:${sort(c)}`).join(",")}}`;
    })(body);
    const hash = keccak_256(new TextEncoder().encode(canonical));

    // ethers.verifyMessage over the (32-byte body hash,
    // 65-byte sig) is exactly the @terminal3/verify_vc
    // `verifyEcdsaVc` path — verifyMessage applies the
    // EIP-191 prefix internally, keccak256s the result,
    // and recovers the address. The address it returns
    // must equal the address the signer intended to use
    // as issuer.
    const wallet = new Wallet(FIXED_PRIVATE_KEY);
    const sig = signed.proof?.jws as `0x${string}`;
    const recovered = verifyMessage(Buffer.from(hash), sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("mintAndSignDelegationCredential writes a signed VC to disk", () => {
    const outPath = join(tmp, "signed-on-disk.json");
    const { path, credential } = mintAndSignDelegationCredential({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 2_500,
      issuerPrivateKey: FIXED_PRIVATE_KEY,
      issuerPublicKey: FIXED_PUBLIC_KEY,
      issuerDid: "did:t3n:0xsigner",
      outputPath: outPath,
    });
    expect(path).toBe(outPath);
    expect(credential.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(credential.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);

    // Round-trip: the on-disk file must parse through the
    // zod schema (proof is now present and valid).
    const loaded = loadDelegationCredential(path);
    expect(loaded.proof?.type).toBe("EcdsaSecp256k1Signature2019");
  });

  // Cleanup
  it("cleanup tmp dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
