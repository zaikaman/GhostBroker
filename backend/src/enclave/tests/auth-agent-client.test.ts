import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { GhostbrokerDelegationAgentAuthClient } from "../auth/agent-auth-client.js";
import { mintTenantDelegation } from "../auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * The verifier runs in `live` mode exclusively: it
 * cryptographically verifies every VC with the T3 SDK's
 * `verifyVc` (which uses the standard EIP-191 personal_sign
 * over `keccak256(JSON.stringify(body))`). There is no
 * `sandbox` demo surface and no `T3_MODE` env var to opt into
 * a structural-only check.
 *
 * For production-style VCs, the SDK path succeeds directly:
 * the signer derives the issuer DID from its keypair's address
 * as `did:ethr:0x<keypair>` so the SDK's `verifyEcdsaVcSig`
 * can match the issuer against the recovered signer. The
 * multi-signer fallback is a safety net for the dev flow
 * (where a hand-crafted VC uses a `did:t3n:` issuer that the
 * SDK rejects as `Unsupported DID method: t3n`); see
 * `agent-auth-sdk-integration.test.ts` for the SDK contract.
 *
 * Tests that exercise a pre-crypto rejection (malformed /
 * expired) use a placeholder JWS — those rejections happen
 * before the cryptographic check, so a fake signature is fine.
 */
const PLACEHOLDER_PROOF_JWS = "0x" + "ab".repeat(64) + "1b";

/**
 * A hand-crafted `did:t3n:` VC used only for the
 * pre-crypto-rejection tests (malformed / expired / wrong
 * scope). The T3 SDK's `verifyEcdsaVcSig` only knows
 * `did:ethr:` and throws `Unsupported DID method: t3n` on
 * this VC, so the verifier's multi-signer fallback path runs.
 * Because the placeholder JWS does not actually verify, the
 * fallback rejects the VC with `unverified`.
 */
const placeholderJwsVc = {
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
    type: "EcdsaSecp256k1Signature2019",
    created: "2026-01-01T00:00:00.000Z",
    proofPurpose: "assertionMethod",
    verificationMethod: "did:t3n:0x0000000000000000000000000000000000000099#key-1",
    jws: PLACEHOLDER_PROOF_JWS,
  },
};

const baseRequest = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:agent:us1-authorized",
  authorityRef: "ghostbroker-delegation:urn:uuid:ghostbroker-delegation-test",
  requestedAction: "agent.admit" as const,
  delegationCredential: placeholderJwsVc,
};

describe("T3 agent delegation adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a placeholder-JWS VC with `unverified` (verifier is live-only)", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();
    const result = await client.verifyDelegation(baseRequest);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("unverified");
  });

  it("rejects an expired VC", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();

    await expect(
      client.verifyDelegation({
        ...baseRequest,
        delegationCredential: {
          ...placeholderJwsVc,
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
      placeholderJwsVc.credentialSubject;
    void _omit;
    const procurementVc = {
      ...placeholderJwsVc,
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

describe("T3 agent delegation adapter (production-style round-trip)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a freshly-minted VC end-to-end via the T3 SDK path (no fallback needed)", async () => {
    // Production flow: the signer derives the issuer DID from
    // its keypair's address as `did:ethr:0x<keypair>`. The
    // T3 SDK's `verifyVc` calls `verifyEcdsaVcSig`, which
    // matches the issuer's embedded address against the
    // recovered signer (`address === recoveredAddress` is
    // true because both come from the same keypair) and
    // returns isValid:true. The verifier reports
    // verificationMode: "live".
    //
    // The test pins the end-to-end SDK round-trip: the agent
    // does NOT need to pass `additionalTrustedSignerAddresses`
    // because the SDK can verify the credential directly.
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-sdk-roundtrip-"));
    try {
      const identity = loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x0000000000000000000000000000000000000099",
        path: join(tmp, "tenant.json"),
      });
      // The signer's DID is now the keypair's did:ethr form,
      // NOT the T3N tenant DID we passed in (which is only
      // recorded for display). The VC's issuer is identity.did.
      expect(identity.did.startsWith("did:ethr:0x")).toBe(true);
      expect(identity.did).toBe(`did:ethr:${getAddress(identity.address)}`);

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
        institutionId: "00000000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: `ghostbroker-delegation:${credential.id}`,
        requestedAction: "agent.admit",
        delegationCredential: credential,
      });
      expect(result.status).toBe("verified");
      if (result.status !== "verified") {
        throw new Error(
          `expected verified, got ${JSON.stringify(result)}`,
        );
      }
      // Stable sha256 policy hash on the verified result.
      expect(result.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("produces a stable sha256 policy hash for the same VC across calls", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-sdk-roundtrip-hash-"));
    try {
      const identity = loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x0000000000000000000000000000000000000099",
        path: join(tmp, "tenant.json"),
      });
      const { credential } = mintTenantDelegation(
        {
          agentDid: "did:t3n:agent:us1-authorized",
          institutionId: "00000000-4000-8000-000000000101",
          maxSpendUsd: 1000,
          allowedActions: ["agent.admit"],
          purpose: "test",
          validityMonths: 12,
        },
        identity,
      );

      const client = new GhostbrokerDelegationAgentAuthClient();
      const first = await client.verifyDelegation({
        institutionId: "00000000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: `ghostbroker-delegation:${credential.id}`,
        requestedAction: "agent.admit",
        delegationCredential: credential,
      });
      const second = await client.verifyDelegation({
        institutionId: "00000000-4000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: `ghostbroker-delegation:${credential.id}`,
        requestedAction: "agent.admit",
        delegationCredential: credential,
      });

      expect(first.status).toBe("verified");
      expect(second.status).toBe("verified");
      if (first.status !== "verified" || second.status !== "verified") {
        throw new Error("unreachable: expected verified status");
      }
      expect(first.policyHash).toBe(second.policyHash);
      expect(first.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a freshly-minted VC when the caller presents a stale authorityRef", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-sdk-roundtrip-overscope-"));
    try {
      const identity = loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x0000000000000000000000000000000000000099",
        path: join(tmp, "tenant.json"),
      });
      const { credential } = mintTenantDelegation(
        {
          agentDid: "did:t3n:agent:us1-authorized",
          institutionId: "00000000-4000-8000-000000000101",
          maxSpendUsd: 1000,
          allowedActions: ["agent.admit"],
          purpose: "test",
          validityMonths: 12,
        },
        identity,
      );

      const client = new GhostbrokerDelegationAgentAuthClient();
      const result = await client.verifyDelegation({
        institutionId: "00000000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:us1-authorized",
        authorityRef: "ghostbroker-delegation:urn:uuid:different-credential",
        requestedAction: "agent.admit",
        delegationCredential: credential,
      });
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("unreachable: expected rejected status");
      }
      expect(result.reason).toBe("over_scoped");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
