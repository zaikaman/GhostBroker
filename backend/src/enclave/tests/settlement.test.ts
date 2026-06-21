import { describe, expect, it } from "vitest";
import {
  SettlementAuthorityError,
  SettlementCommandBuilder,
  SettlementExpiredIntentError,
  type OpaqueMatchOutcome,
  type SettlementAuthorityVerifier,
} from "../matching/index.js";
import type {
  AgentDelegationVerificationResult,
  RequestedAgentAction,
} from "../auth/agent-auth-client.js";

const outcome: OpaqueMatchOutcome = {
  outcomeRef: "match_outcome_us3",
  executionRef: "t3exec_us3",
  buyerInstitutionId: "00000000-0000-4000-8000-000000000301",
  sellerInstitutionId: "00000000-0000-4000-8000-000000000302",
  encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
  buyerAuthorityRef: "authority:buyer:settle",
  sellerAuthorityRef: "authority:seller:settle",
      // v0.8.0: TEE-attested match attestation binding the
  // recorded institution IDs to the match outcome. The
  // settlement command builder threads this through to the
  // audit trail so a judge can re-derive the attestation from
  // the recorded (outcome_ref, institution_id) pair.
  matchAttestationRef: "match_attest_us3",
  expiresAt: "2026-06-13T00:00:00.000Z",
  status: "matched",
  matchedQuantity: 4,
  executionPrice: 50000,
  buyerLockedAmount: 200000,
  sellerLockedAmount: 4,
};

class Verifier implements SettlementAuthorityVerifier {
  public constructor(private readonly status: "verified" | "rejected") {}

  public loadAndVerify(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    requestedAction: RequestedAgentAction;
  }): Promise<AgentDelegationVerificationResult> {
    if (this.status === "verified") {
      return Promise.resolve({
        status: "verified",
        agentDid: input.agentDid,
        authorityRef: `ghostbroker-delegation:${input.agentDid}`,
        policyHash: "policy:us3",
        delegationCredential: { id: `vc-${input.agentDid}` },
      });
    }

    return Promise.resolve({
      status: "rejected",
      agentDid: input.agentDid,
      reason: "revoked",
    });
  }
}

describe("settlement command builder", () => {
  it("builds command after authority recheck", async () => {
    const builder = new SettlementCommandBuilder(new Verifier("verified"));

    await expect(
      builder.build({
        matchOutcome: outcome,
        buyerAgentId: "00000000-0000-4000-8000-000000000a01",
        sellerAgentId: "00000000-0000-4000-8000-000000000a02",
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        now: new Date("2026-06-12T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcomeRef: "match_outcome_us3",
      executionRef: "t3exec_us3",
      encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
    });
  });

  it("fails closed for revoked authority", async () => {
    const builder = new SettlementCommandBuilder(new Verifier("rejected"));

    // Pin `now` to a time before `outcome.expiresAt` so this
    // test exercises the authority-rejection path rather than
    // accidentally falling into the expired-outcome path as
    // real wall-clock time advances past 2026-06-13. Test 1
    // uses the same fixed `now`, keeping the two authority
    // paths on a consistent timeline.
    await expect(
      builder.build({
        matchOutcome: outcome,
        buyerAgentId: "00000000-0000-4000-8000-000000000a01",
        sellerAgentId: "00000000-0000-4000-8000-000000000a02",
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        now: new Date("2026-06-12T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(SettlementAuthorityError);
  });

  it("rejects expired outcomes", async () => {
    const builder = new SettlementCommandBuilder(new Verifier("verified"));

    await expect(
      builder.build({
        matchOutcome: outcome,
        buyerAgentId: "00000000-0000-4000-8000-000000000a01",
        sellerAgentId: "00000000-0000-4000-8000-000000000a02",
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        now: new Date("2026-06-14T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(SettlementExpiredIntentError);
  });
});
