import { describe, expect, it } from "vitest";
import {
  isDelegationActive,
  loadDelegationCredential,
} from "./delegation.js";
import {
  mintDelegationCredentialBody,
  mintAndSignDelegationCredential,
} from "../../sdk/agent-client/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Tests for the agents workspace delegation helpers.
 *
 * The signing logic (canonical-JSON, EIP-191, ECDSA
 * secp256k1) is covered exhaustively in
 * `agent-client/src/delegation-signer.test.ts`. This file
 * focuses on:
 *   - the `delegationSchema` zod validation via `loadDelegationCredential`,
 *   - the `isDelegationActive` time-window helper,
 *   - writing VCs to disk and loading them back.
 *
 * Post-Phase 1: the disk-writing wrappers (`mintDelegationCredential`,
 * `mintAndSignDelegationCredential`) were removed from `delegation.ts`.
 * Tests that need an on-disk VC now use the canonical functions from
 * the agent-client SDK (`backend/src/sdk/agent-client/`) directly.
 */

describe("delegation credential loading / validation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-delegation-test-"));

  it("loads a VC written via mintDelegationCredentialBody through the zod schema", () => {
    const body = mintDelegationCredentialBody({
      issuerDid: "did:t3n:0x0000000000000000000000000000000000000001",
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      purpose: "test",
    });
    const path = join(tmp, "roundtrip.json");
    writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
    const loaded = loadDelegationCredential(path);
    expect(loaded.credentialSubject.agentDid).toBe("did:t3n:0xagent");
    expect(loaded.credentialSubject.maxSpendUsd).toBe(1_000);
    expect(loaded.id).toMatch(/^urn:uuid:ghostbroker-delegation-/);
  });

  it("rejects an unknown action scope", () => {
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
          allowedActions: ["weapons"], // not in the enum
          purpose: "test",
        },
      }),
      "utf8",
    );
    expect(() => loadDelegationCredential(badPath)).toThrow();
  });

  it("isDelegationActive is true within the window and false outside", () => {
    const body = mintDelegationCredentialBody({
      issuerDid: "did:t3n:0x0000000000000000000000000000000000000001",
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      purpose: "test",
    });
    const path = join(tmp, "active.json");
    writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
    const loaded = loadDelegationCredential(path);
    expect(isDelegationActive(loaded, new Date())).toBe(true);
    expect(isDelegationActive(loaded, new Date("2020-01-01T00:00:00Z"))).toBe(false);
  });

  // Cleanup
  it("cleanup tmp dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("signed VC round-trip via the agent-client SDK", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-sign-test-"));

  it("writes a real signed VC to disk that round-trips through the schema", () => {
    const seed = keccak_256(
      new TextEncoder().encode("ghostbroker-agents-test-v1"),
    );
    const privKey = `0x${Buffer.from(seed).toString("hex")}` as `0x${string}`;
    const pubKey = `0x${Buffer.from(secp256k1.getPublicKey(seed, true)).toString("hex")}` as `0x${string}`;

    const outPath = join(tmp, "signed.json");
    const vc = mintAndSignDelegationCredential({
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 2_500,
      issuerPrivateKey: privKey,
      issuerPublicKey: pubKey,
      issuerDid: "did:t3n:0xagent",
    });
    writeFileSync(outPath, JSON.stringify(vc, null, 2), "utf8");
    expect(vc.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(vc.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);

    const loaded = loadDelegationCredential(outPath);
    expect(loaded.proof?.type).toBe("EcdsaSecp256k1Signature2019");
  });

  // Cleanup
  it("cleanup tmp dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
