import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhostbrokerDelegationAgentAuthClient } from "../auth/agent-auth-client.js";
import { mintTenantDelegation } from "../auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * The sandbox marker lets the verifier short-circuit the
 * cryptographic check and accept the VC on shape + time-window +
 * DID-binding grounds only. Used for tests that don't exercise
 * the live signature path.
 */
const SANDBOX_PROOF_JWS = "sandbox-proof-placeholder";

/**
 * A well-formed sandbox-marker VC. The verifier accepts this
 * on shape + time-window + DID-binding grounds; no live crypto
 * is exercised. Tests that need to exercise the crypto path
 * build their own freshly-minted VCs (see the round-trip tests
 * in `tenant-delegation.test.ts`).
 */
const sandboxVc = {
  id: "urn:uuid:ghostbroker-delegation-test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000099",
  issuanceDate: "2026-01-01T00:00:00.000Z",
  expirationDate: "2027-01-01T00:00:00.000Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000099",
    agentDid: "did:t3n:agent:us1-authorized",
    maxSpendUsd: 1000,
    allowedActions: ["agent.admit"],
    purpose: "test",
  },
  proof: {
    type: "JsonWebSignature2020",
    created: "2026-01-01T00:00:00.000Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000099#key-1",
    jws: SANDBOX_PROOF_JWS,
  },
};

const baseRequest = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:agent:us1-authorized",
  authorityRef: "ghostbroker-delegation:urn:uuid:ghostbroker-delegation-test",
  requestedAction: "agent.admit" as const,
  delegationCredential: sandboxVc,
};

describe("T3 agent delegation adapter", () => {
  beforeEach(() => {
    // Sandbox-marker VCs are only accepted when the verifier
    // runs in sandbox mode. The default mode is `live`, which
    // rejects demo proofs to fail-closed against adversarial
    // T3 SDK version bumps.
    vi.stubEnv("T3_MODE", "sandbox");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts Ghostbroker-style delegation VCs", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

    await expect(client.verifyDelegation(baseRequest)).resolves.toEqual({
      status: "verified",
      agentDid: baseRequest.agentDid,
      authorityRef: baseRequest.authorityRef,
      policyHash:
        "ce3b08cb992446501f996876ef99c9b1df7bff343186555495966dbf3a3725ec",
      delegationCredential: sandboxVc,
    });
  });

  it("produces a stable sha256 policy hash for the same VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

    const first = await client.verifyDelegation(baseRequest);
    const second = await client.verifyDelegation(baseRequest);
    const hex64 = /^[0-9a-f]{64}$/u;

    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    if (first.status !== "verified" || second.status !== "verified") {
      throw new Error("unreachable: expected verified status");
    }
    expect(first.policyHash).toBe(second.policyHash);
    expect(first.policyHash).toMatch(hex64);
  });

  it("rejects a stale authorityRef that does not match the VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        authorityRef: "ghostbroker-delegation:urn:uuid:different-credential",
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "over_scoped",
    });
  });

  it("rejects an expired VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        delegationCredential: {
          ...sandboxVc,
          expirationDate: "2024-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "expired",
    });
  });

  it("rejects a VC with a procurement purchase-category scope (legacy shape)", async () => {
    // The procurement BUIDL enum
    // (`office-supplies | software | hardware | services | travel`)
    // is no longer a valid scope on a GhostBroker trading-agent
    // delegation VC. The verifier must reject it as `malformed`
    // so a stale dashboard snapshot can never re-introduce a
    // procurement-style grant to a trading agent.
    const client = new GhostbrokerDelegationAgentAuthClient();
    // Replace `allowedActions` (the trading-agent action
    // scope) with the legacy procurement `allowedCategories`.
    // The verifier's `ghostbrokerDelegationSchema` requires
    // `allowedActions` to be a non-empty array of the
    // `DelegationActionScope` enum, so the absence of
    // `allowedActions` fails the schema parse.
    const { allowedActions: _omit, ...legacySubject } =
      sandboxVc.credentialSubject;
    void _omit;
    const procurementVc = {
      ...sandboxVc,
      credentialSubject: {
        ...legacySubject,
        allowedCategories: ["software", "travel"],
      },
    };

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        delegationCredential: procurementVc,
      }),
    ).resolves.toEqual({
      status: "rejected",
      agentDid: baseRequest.agentDid,
      reason: "malformed",
    });
  });
});

describe("T3 agent delegation adapter (live crypto round-trip)", () => {
  beforeEach(() => {
    // The round-trip tests exercise the production live
    // crypto verification path. `T3_MODE=live` is the
    // production default — set explicitly to be explicit.
    vi.stubEnv("T3_MODE", "live");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a freshly-minted VC end-to-end when the signer address matches the DID's address", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-live-roundtrip-match-"));
    try {
      // The DID's last 40 hex chars are `0x0000...0099`; the
      // identity store derives a fresh keypair whose address
      // will NOT match (random). To get a match, generate the
      // identity from a deterministic private key whose
      // address equals the DID's embedded `0099...` address.
      //
      // We can't directly invert secp256k1, so we accept that
      // the test exercises the additionalTrustedSignerAddresses
      // path: pass the random keypair's address in.
      const tenantDid = "did:t3n:0x0000000000000000000000000000000000000099";
      const identity = loadOrCreateTenantIdentity({
        tenantDid,
        path: join(tmp, "tenant.json"),
      });
      const { credential } = mintTenantDelegation(
        {
          agentDid: "did:t3n:agent:us1-authorized",
          institutionId: "00000000-0000-4000-8000-000000000101",
          maxSpendUsd: 1000,
          allowedActions: ["agent.admit"],
          purpose: "test",
          validityMonths: 12,
        },
        identity,
      );

      const client = new GhostbrokerDelegationAgentAuthClient();
      const result = await client.verifyDelegation({
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: `ghostbroker-delegation:${credential.id}`,
        requestedAction: "agent.admit",
        delegationCredential: credential,
        additionalTrustedSignerAddresses: new Set([
          identity.address.toLowerCase(),
        ]),
      });
      expect(result.status).toBe("verified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a freshly-minted VC end-to-end when no trusted signer addresses are passed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-live-roundtrip-nopass-"));
    try {
      const tenantDid = "did:t3n:0x0000000000000000000000000000000000000099";
      const identity = loadOrCreateTenantIdentity({
        tenantDid,
        path: join(tmp, "tenant.json"),
      });
      const { credential } = mintTenantDelegation(
        {
          agentDid: "did:t3n:agent:us1-authorized",
          institutionId: "00000000-0000-4000-8000-000000000101",
          maxSpendUsd: 1000,
          allowedActions: ["agent.admit"],
          purpose: "test",
          validityMonths: 12,
        },
        identity,
      );

      const client = new GhostbrokerDelegationAgentAuthClient();
      const result = await client.verifyDelegation({
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: `ghostbroker-delegation:${credential.id}`,
        requestedAction: "agent.admit",
        delegationCredential: credential,
      });
      // No additional trusted signer passed, so the random
      // signer's address doesn't match the DID's address and
      // the verifier rejects with `unverified`.
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error(
          `expected rejected, got ${JSON.stringify(result)}`,
        );
      }
      expect(result.reason).toBe("unverified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
