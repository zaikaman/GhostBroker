import { describe, expect, it } from "vitest";
import {
  SettlementAuthorityError,
  SettlementCommandBuilder,
  SettlementExpiredIntentError,
  type OpaqueMatchOutcome,
  type SettlementAuthorityVerifier,
} from "../matching/index.js";

const outcome: OpaqueMatchOutcome = {
  outcomeRef: "match_outcome_us3",
  executionRef: "t3exec_us3",
  buyerInstitutionId: "00000000-0000-4000-8000-000000000301",
  sellerInstitutionId: "00000000-0000-4000-8000-000000000302",
  encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
  buyerAuthorityRef: "authority:buyer:settle",
  sellerAuthorityRef: "authority:seller:settle",
  expiresAt: "2026-06-13T00:00:00.000Z",
  status: "matched",
};

const buyerVc = { id: "buyer-vc", issuer: "did:t3n:buyer" };
const sellerVc = { id: "seller-vc", issuer: "did:t3n:seller" };

class Verifier implements SettlementAuthorityVerifier {
  public constructor(private readonly status: "verified" | "rejected") {}

  public async verifyAgentAuthority(
    request: Parameters<SettlementAuthorityVerifier["verifyAgentAuthority"]>[0],
  ) {
    if (this.status === "verified") {
      return {
        status: "verified" as const,
        agentDid: request.agentDid,
        authorityRef: request.authorityRef,
        policyHash: "policy:us3",
      };
    }

    return {
      status: "rejected" as const,
      agentDid: request.agentDid,
      reason: "revoked" as const,
    };
  }
}

describe("settlement command builder", () => {
  it("builds command after authority recheck", async () => {
    const builder = new SettlementCommandBuilder(new Verifier("verified"));

    await expect(
      builder.build({
        matchOutcome: outcome,
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        buyerDelegationCredential: buyerVc,
        sellerDelegationCredential: sellerVc,
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
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        buyerDelegationCredential: buyerVc,
        sellerDelegationCredential: sellerVc,
        now: new Date("2026-06-12T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(SettlementAuthorityError);
  });

  it("rejects expired outcomes", async () => {
    const builder = new SettlementCommandBuilder(new Verifier("verified"));

    await expect(
      builder.build({
        matchOutcome: outcome,
        buyerAgentDid: "did:t3n:agent:buyer-us3",
        sellerAgentDid: "did:t3n:agent:seller-us3",
        buyerDelegationCredential: buyerVc,
        sellerDelegationCredential: sellerVc,
        now: new Date("2026-06-14T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(SettlementExpiredIntentError);
  });
});
