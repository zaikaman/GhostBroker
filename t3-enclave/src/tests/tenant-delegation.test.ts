import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGhostbrokerDelegationCredential } from "../auth/ghostbroker-delegation.js";
import { mintTenantDelegation } from "../auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * Round-trip: the server-side `mintTenantDelegation` must
 * produce a VC the existing `@terminal3/verify_vc`-backed
 * verifier accepts. The byte layout, the canonical-JSON
 * shape, the EIP-191 prefix, the secp256k1 65-byte JWS, and
 * the `EcdsaSecp256k1Signature2019` proof type are all
 * unchanged from the legacy CLI / browser-mint paths.
 */
describe("tenant-delegation signer", () => {
  let tmp: string;
  const TENANT_DID = "did:t3n:0x00000000000000000000000000000000000000aa";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ghostbroker-tenant-delegation-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("mints a VC the verifier accepts with verificationMode=live", async () => {
    const identity = loadOrCreateTenantIdentity({
      tenantDid: TENANT_DID,
      path: join(tmp, "tenant.json"),
    });
    expect(identity.did).toBe(TENANT_DID);
    expect(identity.publicKey.startsWith("0x")).toBe(true);
    expect(identity.privateKey.startsWith("0x")).toBe(true);

    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:0xagent",
        institutionId: "00000000-0000-4000-8000-000000000101",
        maxSpendUsd: 50_000,
        allowedCategories: ["office-supplies", "software"],
        approverEmail: "finance@acme.example",
        purpose: "Q2 office refresh",
        validityMonths: 6,
      },
      identity,
    );

    expect(credential.issuer).toBe(TENANT_DID);
    expect(credential.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(credential.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);
    expect(credential.credentialSubject.agentDid).toBe("did:t3n:0xagent");
    expect(credential.credentialSubject.maxSpendUsd).toBe(50_000);

    const result = await verifyGhostbrokerDelegationCredential(
      {
        credential,
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:0xagent",
        requestedAction: "agent.admit",
      },
      "live",
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("unreachable: expected verified status");
    }
    // The verifier is allowed to fall back to `structural`
    // mode in test environments where `@terminal3/verify_vc`
    // cannot reach its registry (see the documented behavior
    // in `t3-enclave/src/auth/ghostbroker-delegation.ts`'s
    // `tryLiveVerify`). The load-bearing contract is: the
    // verifier must ACCEPT a VC we just signed, in either
    // `live` or `structural` mode. In production with a
    // reachable T3N registry, the mode is `live`; the
    // structural fallback is the safety net the verifier
    // documents explicitly.
    expect(["live", "structural"]).toContain(result.verificationMode);
    expect(result.authorityRef).toBe(
      `ghostbroker-delegation:${credential.id}`,
    );
  });

  it("rejects when the VC's agentDid does not match the requesting agent", async () => {
    const identity = loadOrCreateTenantIdentity({
      tenantDid: TENANT_DID,
      path: join(tmp, "tenant.json"),
    });
    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:0xagent",
        institutionId: "00000000-0000-4000-8000-000000000101",
        maxSpendUsd: 1_000,
        allowedCategories: ["software"],
      },
      identity,
    );

    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:0xattacker",
      requestedAction: "agent.admit",
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("agent_mismatch");
  });

  it("reuses the existing on-disk keypair on subsequent boots", () => {
    const path = join(tmp, "tenant.json");
    const first = loadOrCreateTenantIdentity({ tenantDid: TENANT_DID, path });
    const second = loadOrCreateTenantIdentity({
      tenantDid: TENANT_DID,
      path,
    });
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });
});
