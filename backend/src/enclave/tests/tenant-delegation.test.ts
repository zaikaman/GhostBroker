import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGhostbrokerDelegationCredential } from "../auth/ghostbroker-delegation.js";
import { mintTenantDelegation } from "../auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * Round-trip: the server-side `mintTenantDelegation` must
 * produce a VC the live ECDSA verifier accepts. The byte
 * layout, the canonical-JSON shape, the EIP-191 prefix,
 * the secp256k1 65-byte JWS, and the
 * `EcdsaSecp256k1Signature2019` proof type are all
 * unchanged from the legacy CLI / browser-mint paths.
 *
 * The verifier runs in `live` mode exclusively — there is
 * no longer a `structural` opt-in to fall through to. Tests
 * that previously used the explicit `structural` mode have
 * been re-targeted at the live verifier.
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
        allowedActions: ["agent.admit", "intent.submit"],
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
        additionalTrustedSignerAddresses: new Set([
          identity.address.toLowerCase(),
        ]),
      },
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("unreachable: expected verified status");
    }
    // The verifier is `live` mode exclusively; the literal
    // union has collapsed to one value.
    expect(result.verificationMode).toBe("live");
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
        allowedActions: ["agent.admit"],
      },
      identity,
    );

    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:0xattacker",
      requestedAction: "agent.admit",
      additionalTrustedSignerAddresses: new Set([
        identity.address.toLowerCase(),
      ]),
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
    expect(second.address).toBe(first.address);
  });

  it("accepts a freshly-minted VC in live mode when the API-key signer's address is passed as an additional trusted signer", async () => {
    // This is the production case: the tenant DID's address
    // differs from the API key's derived address. The signer
    // signs with the API key; the verifier checks the recovered
    // signature against the API key's address.
    const apiKeyLikePrivateKey =
      "0x96bfcbce2e97420b356695ebd8987b6d9a5658d7221ed9bed9e3b7da6b7d45f6";
    const tenantDid =
      "did:t3n:a07f5f528c01e22dfd229a027c4b4afa4514e952";

    const identity = loadOrCreateTenantIdentity({
      tenantDid,
      path: join(tmp, "tenant-mismatch.json"),
      signingPrivateKey: apiKeyLikePrivateKey,
    });
    // The signing keypair's address should differ from the DID's
    // embedded address (this is the production case).
    expect(identity.address.toLowerCase()).not.toBe(
      "0xa07f5f528c01e22dfd229a027c4b4afa4514e952",
    );

    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:0xd46daba8762b02fd056ff3f2707915e049c075c1",
        institutionId: "00000000-0000-4000-8000-000000000101",
        maxSpendUsd: 50_000,
        allowedActions: [
          "agent.admit",
          "intent.submit",
          "negotiation.open",
          "negotiation.move",
          "negotiation.disclose",
          "negotiation.settle",
        ],
      },
      identity,
    );

    // Round-trip: the verifier must accept the VC when the API
    // key's derived address is in the trusted-signer set.
    const result = await verifyGhostbrokerDelegationCredential(
      {
        credential,
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:0xd46daba8762b02fd056ff3f2707915e049c075c1",
        requestedAction: "agent.admit",
        additionalTrustedSignerAddresses: new Set([
          identity.address.toLowerCase(),
        ]),
      },
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error(
        `expected verified, got ${JSON.stringify(result)}`,
      );
    }
    expect(result.authorityRef).toBe(
      `ghostbroker-delegation:${credential.id}`,
    );
  });

  it("rejects a freshly-minted VC in live mode when the API-key signer's address is NOT passed as an additional trusted signer", async () => {
    // Same as the previous test but WITHOUT the additional
    // trusted signer. The verifier should reject because the
    // recovered signature is the API key's address, which
    // differs from the issuer DID's address.
    const apiKeyLikePrivateKey =
      "0x96bfcbce2e97420b356695ebd8987b6d9a5658d7221ed9bed9e3b7da6b7d45f6";
    const tenantDid =
      "did:t3n:a07f5f528c01e22dfd229a027c4b4afa4514e952";

    const identity = loadOrCreateTenantIdentity({
      tenantDid,
      path: join(tmp, "tenant-mismatch-no-trust.json"),
      signingPrivateKey: apiKeyLikePrivateKey,
    });

    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:0xd46daba8762b02fd056ff3f2707915e049c075c1",
        institutionId: "00000000-0000-4000-8000-000000000101",
        maxSpendUsd: 50_000,
        allowedActions: ["agent.admit", "intent.submit"],
      },
      identity,
    );

    const result = await verifyGhostbrokerDelegationCredential(
      {
        credential,
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:0xd46daba8762b02fd056ff3f2707915e049c075c1",
        requestedAction: "agent.admit",
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error(
        `expected rejected, got ${JSON.stringify(result)}`,
      );
    }
    expect(result.reason).toBe("unverified");
  });
});
