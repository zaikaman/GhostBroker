import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { verifyGhostbrokerDelegationCredential } from "../auth/ghostbroker-delegation.js";
import { mintTenantDelegation } from "../auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * Round-trip: the server-side `mintTenantDelegation` must
 * produce a VC the verifier accepts. The byte layout, the
 * canonical-JSON shape, the EIP-191 prefix, the secp256k1
 * 65-byte JWS, and the `EcdsaSecp256k1Signature2019` proof
 * type are all unchanged from the legacy CLI / browser-mint
 * paths.
 *
 * The verifier runs in `live` mode exclusively. The T3 SDK's
 * `verifyVc` is exercised on every call; the multi-signer
 * fallback is the dev-case safety net (see
 * `agent-auth-sdk-integration.test.ts` for the SDK contract).
 */
describe("tenant-delegation signer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ghostbroker-tenant-delegation-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("mints a VC the verifier accepts with verificationMode=live", async () => {
    // The signer keypair's derived address is the canonical
    // issuer DID — `did:ethr:0x<keypair-address>` — so the T3
    // SDK's `verifyEcdsaVcSig` matches the issuer against the
    // recovered signer and the SDK call returns isValid:true.
    // The `tenantDid` parameter is the institution's T3N
    // identity (recorded separately for display); it does NOT
    // appear on the VC body.
    const identity = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path: join(tmp, "tenant.json"),
    });
    expect(identity.did.startsWith("did:ethr:0x")).toBe(true);
    expect(identity.did).toBe(`did:ethr:${getAddress(identity.address)}`);
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

    // The VC's issuer is the keypair's did:ethr form, NOT
    // the T3N tenant DID — the signer mints with the keypair
    // identity so the T3 SDK's `verifyEcdsaVcSig` can match
    // the issuer against the recovered signer.
    expect(credential.issuer).toBe(identity.did);
    expect(credential.issuer.startsWith("did:ethr:0x")).toBe(true);
    expect(credential.proof?.type).toBe("EcdsaSecp256k1Signature2019");
    expect(credential.proof?.jws).toMatch(/^0x[0-9a-f]{130}$/);
    expect(credential.credentialSubject.agentDid).toBe("did:t3n:0xagent");
    expect(credential.credentialSubject.maxSpendUsd).toBe(50_000);

    // The SDK path succeeds directly because signer == issuer:
    // the T3 SDK's `verifyEcdsaVcSig` matches the issuer's
    // embedded address against the recovered signer and
    // returns `isValid: true`. There is no multi-signer
    // fallback path.
    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:0xagent",
      requestedAction: "agent.admit",
    });
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
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path: join(tmp, "tenant-mismatch.json"),
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
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("agent_mismatch");
  });

  it("reuses the existing on-disk keypair on subsequent boots", () => {
    const path = join(tmp, "tenant.json");
    const first = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path,
    });
    const second = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path,
    });
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.address).toBe(first.address);
    expect(second.did).toBe(first.did);
  });

  it("derives a new did:ethr:0x<address> on each fresh keypair (so the T3 SDK can verify directly)", () => {
    // Two fresh identities with two different keypairs must
    // have two different `did:ethr:0x<address>` issuers, with
    // each DID's address matching the respective keypair's
    // address. This pins the invariant that lets
    // `verifyEcdsaVcSig` succeed without the multi-signer
    // fallback path.
    const a = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000a1",
      path: join(tmp, "tenant-a.json"),
    });
    const b = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000a2",
      path: join(tmp, "tenant-b.json"),
    });
    expect(a.did).not.toBe(b.did);
    expect(a.did).toBe(`did:ethr:${getAddress(a.address)}`);
    expect(b.did).toBe(`did:ethr:${getAddress(b.address)}`);
  });

  it("accepts a freshly-minted VC in live mode when an explicit signing key is provided", async () => {
    // Production case: the institution has both a T3N tenant
    // identity (`did:t3n:0x<addr>`, recorded for display) and
    // a dedicated secp256k1 signing key loaded from a secret
    // manager via `TENANT_SIGNING_PRIVATE_KEY`. The signer
    // mints VCs with the signing key's `did:ethr:0x<derived>`
    // as the issuer. The verifier's `verifyEcdsaVcSig`
    // matches the issuer against the recovered signer; no
    // additional trusted signer is needed.
    //
    // This test pins the C1 fix: the T3N bearer API key MUST
    // NOT be used as the signing key. The signing key is a
    // separate, dedicated secp256k1 keypair — in production,
    // a fresh CSPRNG-generated keypair persisted to the file
    // store, or loaded from a secret manager.
    const dedicatedSigningKey =
      "0x96bfcbce2e97420b356695ebd8987b6d9a5658d7221ed9bed9e3b7da6b7d45f6";

    const identity = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:a07f5f528c01e22dfd229a027c4b4afa4514e952",
      path: join(tmp, "tenant-mismatch.json"),
      signingPrivateKey: dedicatedSigningKey,
    });
    // The VC's issuer is the keypair's did:ethr form, NOT
    // the T3N tenant DID — that's the whole point of the
    // production case: signer == issuer so the SDK verifies
    // the VC directly with no fallback.
    expect(identity.did.startsWith("did:ethr:0x")).toBe(true);
    expect(identity.did).toBe(`did:ethr:${getAddress(identity.address)}`);

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

    // Round-trip: the verifier accepts the VC via the SDK
    // path (signer == issuer). The T3 SDK's `verifyEcdsaVcSig`
    // matches the issuer's embedded address against the
    // recovered signer and returns `isValid: true` directly.
    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:0xd46daba8762b02fd056ff3f2707915e049c075c1",
      requestedAction: "agent.admit",
    });

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

  it("verifies a VC minted by a CSPRNG-generated signing key without additional trusted signers", async () => {
    // Production case (file-backed identity store): no
    // explicit signing key is provided to
    // `loadOrCreateTenantIdentity`, so it generates a fresh
    // secp256k1 keypair from a CSPRNG and persists it to
    // disk. The signer mints VCs with the keypair's
    // `did:ethr:0x<derived>` as the issuer. The verifier's
    // `verifyEcdsaVcSig` matches the issuer against the
    // recovered signer; the SDK verifies the VC directly
    // and returns `isValid: true`.
    const identity = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path: join(tmp, "tenant-csprng.json"),
    });
    expect(identity.did.startsWith("did:ethr:0x")).toBe(true);
    expect(identity.did).toBe(`did:ethr:${getAddress(identity.address)}`);

    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:agent:us1-authorized",
        institutionId: "00000000-0000-4000-8000-000000000101",
        maxSpendUsd: 1_000,
        allowedActions: ["agent.admit", "intent.submit"],
      },
      identity,
    );

    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:us1-authorized",
      requestedAction: "agent.admit",
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error(
        `expected verified, got ${JSON.stringify(result)}`,
      );
    }
  });

  it("rejects a T3N bearer API key passed as the signing key (C1 dual-use guard)", () => {
    // Regression test for the C1 architecture flaw: the T3N
    // bearer API key (a separate secret that authenticates the
    // T3 SDK to T3N REST/WS calls) MUST NOT be used as the
    // tenant's secp256k1 signing key. Conflating the two would
    // couple the institution's VC lifecycle to the bearer
    // secret's rotation cadence (rotating the API key would
    // invalidate every issued VC).
    //
    // The T3N API key has a different shape from a secp256k1
    // private key (the SDK's `metamask_sign` accepts a wider
    // variety of inputs than the canonical 32-byte private
    // key). `normalizeSigningPrivateKey` rejects the
    // dual-use path with a descriptive error so any future
    // caller wiring `T3N_API_KEY` here fails fast.
    expect(() =>
      loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
        path: join(tmp, "tenant-rejected.json"),
        signingPrivateKey: "not-a-valid-private-key",
      }),
    ).toThrow(/Tenant signing private key must be a 32-byte secp256k1 key/u);

    // A key with the wrong length (e.g. 31 bytes, or 33) is
    // also rejected. The T3 SDK tolerates some of these on
    // the bearer-auth side; the signer-side validator is
    // intentionally stricter.
    expect(() =>
      loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
        path: join(tmp, "tenant-rejected-2.json"),
        signingPrivateKey: "0x" + "ab".repeat(31),
      }),
    ).toThrow(/32-byte secp256k1 key/u);

    // A key with only whitespace (truthy but invalid shape)
    // is rejected. `normalizeSigningPrivateKey` strips
    // whitespace before validating, so a single space yields
    // an empty post-strip string and fails the regex.
    expect(() =>
      loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
        path: join(tmp, "tenant-rejected-3.json"),
        signingPrivateKey: " ",
      }),
    ).toThrow(/32-byte secp256k1 key/u);
  });
});
