/**
 * Action-scope enforcement for the Ghostbroker delegation verifier.
 *
 * The verifier is the single source of truth on agent authority —
 * the `credentialSubject.allowedActions` array on the W3C VC is
 * what the bounty submission (SUBMISSION.md, README.md) promises
 * gates privileged actions like `intent.submit`,
 * `settlement.execute`, `negotiation.move`, etc.
 *
 * Before the action-scope fix landed, the verifier accepted any
 * `requestedAction` as long as the credential bound to the right
 * agent DID — a VC scoped only to `["agent.admit"]` would be
 * honoured for `intent.submit`, `settlement.execute`, and every
 * `negotiation.*` action. This file pins the post-fix contract:
 *
 *   1. The verifier rejects `requestedAction` values not present
 *      in `allowedActions` with reason `action_not_allowed`,
 *      BEFORE the cryptographic verification path runs (the
 *      check is a pure in-memory `includes()`).
 *   2. Each privileged action has a distinct scope string, and
 *      `intent.cancel` is treated as separate from
 *      `intent.submit` — a VC that grants `intent.submit` cannot
 *      be used to cancel intents.
 *   3. The reason `action_not_allowed` is wired through the
 *      `AgentDelegationRejectionReason` union on the
 *      `GhostbrokerDelegationAgentAuthClient` facade so the
 *      orchestrator surfaces the rejection to the caller as a
 *      `PublicError("authorization_failed", 403)`.
 *
 * The tests in this file use a hoisted `vi.mock` of
 * `@terminal3/verify_vc` so we can prove the action-scope
 * rejection happens BEFORE the SDK crypto call — the verifier
 * must not pay the SDK round-trip cost for an action that is
 * already out-of-scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spy on the T3 SDK's `verifyVc` so we can assert the
 * action-scope check fires BEFORE the SDK call. The spy returns
 * `isValid: true` so anything that does reach the SDK would
 * succeed; the action-scope rejection must short-circuit first.
 */
const verifyVcSpy = vi.fn().mockResolvedValue({
  isValid: true,
  message: "Verification successful",
});

vi.mock("@terminal3/verify_vc", () => ({
  verifyVc: verifyVcSpy,
}));

const { verifyGhostbrokerDelegationCredential } = await import(
  "../auth/ghostbroker-delegation.js"
);
const { GhostbrokerDelegationAgentAuthClient } = await import(
  "../auth/agent-auth-client.js"
);
const { mintTenantDelegation } = await import(
  "../auth/tenant-delegation.js"
);
const { loadOrCreateTenantIdentity } = await import(
  "../sandbox/tenant-identity-store.js"
);

const baseVcShape = {
  id: "urn:uuid:ghostbroker-action-scope-test",
  type: ["VerifiableCredential", "GhostBrokerDelegation"],
  issuer: "did:t3n:0x0000000000000000000000000000000000000099",
  issuanceDate: "2026-01-01T00:00:00.000Z",
  expirationDate: "2027-01-01T00:00:00.000Z",
  credentialSubject: {
    id: "did:t3n:0x0000000000000000000000000000000000000099",
    agentDid: "did:t3n:agent:action-scope-test",
    maxSpendUsd: 1000,
    allowedActions: ["agent.admit"],
    purpose: "action-scope-test",
  },
  proof: {
    type: "EcdsaSecp256k1Signature2019",
    created: "2026-01-01T00:00:00.000Z",
    proofPurpose: "assertionMethod",
    verificationMethod:
      "did:t3n:0x0000000000000000000000000000000000000099#key-1",
    jws: "0x" + "ab".repeat(64) + "1b",
  },
} as const;

describe("Ghostbroker verifier action-scope enforcement", () => {
  beforeEach(() => {
    verifyVcSpy.mockClear();
    verifyVcSpy.mockResolvedValue({
      isValid: true,
      message: "Verification successful",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects intent.submit when allowedActions is [agent.admit] only", async () => {
    const result = await verifyGhostbrokerDelegationCredential({
      credential: baseVcShape,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:action-scope-test",
      requestedAction: "intent.submit",
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("action_not_allowed");
    // The action-scope check must short-circuit BEFORE the SDK
    // crypto call. Otherwise an attacker holding an
    // `agent.admit`-scoped VC could burn the SDK's verifyVc
    // budget on every intent.submit attempt.
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("rejects settlement.execute when allowedActions is [agent.admit] only", async () => {
    const result = await verifyGhostbrokerDelegationCredential({
      credential: baseVcShape,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:action-scope-test",
      requestedAction: "settlement.execute",
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("action_not_allowed");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("rejects every negotiation.* action when allowedActions is [agent.admit] only", async () => {
    const negotiationActions = [
      "negotiation.open",
      "negotiation.move",
      "negotiation.disclose",
      "negotiation.settle",
    ] as const;

    for (const requestedAction of negotiationActions) {
      const result = await verifyGhostbrokerDelegationCredential({
        credential: baseVcShape,
        institutionId: "00000000-0000-4000-8000-000000000101",
        agentDid: "did:t3n:agent:action-scope-test",
        requestedAction,
      });
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error(
          `unreachable: ${requestedAction} must be rejected out-of-scope`,
        );
      }
      expect(result.reason).toBe("action_not_allowed");
    }
    // None of the four negotiation.* attempts reached the SDK.
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("rejects intent.cancel even when allowedActions includes intent.submit", async () => {
    // intent.cancel is a separate action from intent.submit —
    // a VC scoped only to submit cannot be used to cancel.
    // This is the load-bearing guard that prevents an agent
    // whose submit authority has expired or been downscoped
    // from cancelling intents as a side door.
    const submitOnlyVc = {
      ...baseVcShape,
      credentialSubject: {
        ...baseVcShape.credentialSubject,
        allowedActions: ["agent.admit", "intent.submit"],
      },
    };
    const result = await verifyGhostbrokerDelegationCredential({
      credential: submitOnlyVc,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:action-scope-test",
      requestedAction: "intent.cancel",
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("action_not_allowed");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("runs the action-scope check before DID-binding and revocation", async () => {
    // Defensive ordering: the action-scope check sits between
    // DID-binding and revocation. Pin the contract by
    // constructing a VC where the action scope fails FIRST
    // (the request asks for `settlement.execute`, the VC only
    // grants `agent.admit`). The verifier must short-circuit
    // on action-scope; it must not waste time on a revocation
    // lookup or the SDK call.
    const result = await verifyGhostbrokerDelegationCredential({
      credential: baseVcShape,
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:action-scope-test",
      requestedAction: "settlement.execute",
      revokedAuthorityRefs: new Set([
        "ghostbroker-delegation:urn:uuid:ghostbroker-action-scope-test",
      ]),
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("action_not_allowed");
    expect(verifyVcSpy).not.toHaveBeenCalled();
  });

  it("propagates action_not_allowed through the Ghostbroker agent-auth facade", async () => {
    const client = new GhostbrokerDelegationAgentAuthClient();
    const result = await client.verifyDelegation({
      institutionId: "00000000-0000-4000-8000-000000000101",
      agentDid: "did:t3n:agent:action-scope-test",
      authorityRef: "ghostbroker-delegation:urn:uuid:ghostbroker-action-scope-test",
      requestedAction: "intent.submit",
      delegationCredential: baseVcShape,
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable: expected rejected status");
    }
    expect(result.reason).toBe("action_not_allowed");
  });

  it("round-trips a freshly-minted VC whose allowedActions match every requestedAction", async () => {
    // The complement of the rejection tests: a VC whose
    // allowedActions covers every privileged action must
    // verify successfully for every privileged action. This
    // pins that the action-scope check is `includes()`, not a
    // buggy equality check that would reject even valid
    // multi-scope VCs.
    const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-action-scope-ok-"));
    try {
      const identity = loadOrCreateTenantIdentity({
        tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
        path: join(tmp, "tenant.json"),
      });
      const { credential } = mintTenantDelegation(
        {
          agentDid: "did:t3n:agent:full-scope-test",
          institutionId: "00000000-0000-4000-8000-000000000101",
          maxSpendUsd: 1_000,
          allowedActions: [
            "agent.admit",
            "intent.submit",
            "intent.cancel",
            "settlement.execute",
            "negotiation.open",
            "negotiation.move",
            "negotiation.disclose",
            "negotiation.settle",
          ],
          purpose: "full-scope",
          validityMonths: 12,
        },
        identity,
      );

      for (const requestedAction of [
        "agent.admit",
        "intent.submit",
        "intent.cancel",
        "settlement.execute",
        "negotiation.open",
        "negotiation.move",
        "negotiation.disclose",
        "negotiation.settle",
      ] as const) {
        const result = await verifyGhostbrokerDelegationCredential({
          credential,
          institutionId: "00000000-0000-4000-8000-000000000101",
          agentDid: "did:t3n:agent:full-scope-test",
          requestedAction,
        });
        expect(result.status).toBe("verified");
        if (result.status !== "verified") {
          throw new Error(
            `unreachable: ${requestedAction} must verify for a full-scope VC`,
          );
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});