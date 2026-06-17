import { describe, expect, it } from "vitest";
import { negotiationDecisionSchema } from "./negotiation-decision.js";
import {
  buildTurnContext,
  deriveExecutionRails,
  normalizeStrategy,
  type AuthoredMandatePolicy,
} from "@ghostbroker/negotiation-core";
import { clampNegotiationDecision } from "./negotiation-decision.js";
import type { NegotiationContext } from "./negotiation-decision.js";

const authored: AuthoredMandatePolicy = {
  objective: "Acquire strategic BTC exposure",
  assetCode: "WBTC",
  side: "buy",
  sizePolicy: {
    targetQuantity: 10,
    minimumQuantity: 1,
    partialExecutionAllowed: true,
  },
  urgency: "normal",
  executionStyle: "balanced",
  valuationPolicy: { source: "operator_note", anchorValue: 70_000 },
  concessionPolicy: { pace: "balanced", maxConcessionBps: 200 },
  disclosurePolicy: {
    allowLadder: ["accredited_institution", "settlement_capacity"],
    requireReciprocityFor: [],
  },
  counterpartyRequirements: {
    requiredClaims: ["accredited_institution"],
    disallowedTraits: [],
  },
  approvalPolicy: { mode: "auto_settle" },
  timeWindow: { deadline: new Date(Date.now() + 86_400_000).toISOString() },
  operatorInstructions: "Be patient but get the deal done.",
};

function buildContext(overrides: Partial<NegotiationContext> = {}): NegotiationContext {
  const profile = normalizeStrategy(authored);
  const rails = deriveExecutionRails(authored);
  const baseCtx = buildTurnContext({
    profile,
    side: "buy",
    roundNumber: 1,
    maxRounds: 12,
    deadline: profile.authored.timeWindow.deadline,
    distanceSignal: "moderate",
    counterpartStandingPrice: null,
    counterpartStandingQuantity: null,
    receivedClaims: [],
    concessionConsumedBps: 0,
    operatorInstructions: "Be patient but get the deal done.",
  });
  return {
    ...baseCtx,
    quoteAssetCode: "USDC",
    targetQuantity: rails.targetQuantity,
    minimumQuantity: rails.minimumQuantity,
    maxNotional: rails.notionalCeiling,
    maxPrice: baseCtx.maxPrice,
    roundNumber: 1,
    maxRounds: 12,
    roundsRemaining: 11,
    timeToDeadlineMs: 86_400_000,
    counterpartPattern: "unknown",
    counterpartStandingPrice: null,
    counterpartStandingQuantity: null,
    disclosableClaims: ["accredited_institution", "settlement_capacity"],
    receivedClaims: [],
    requiredClaims: ["accredited_institution"],
    trustLevel: "none",
    operatorInstructions: "Be patient but get the deal done.",
    ...overrides,
  };
}

const baseCtx: NegotiationContext = buildContext();

describe("negotiationDecisionSchema", () => {
  it("accepts every supported action", () => {
    for (const action of [
      "propose",
      "counter",
      "reveal",
      "request_disclosure",
      "accept",
      "hold",
      "walkaway",
    ] as const) {
      const parsed = negotiationDecisionSchema.parse({
        action,
        price: 70_000,
        quantity: 1,
        strategicIntent: "open_patiently",
        confidence: 0.8,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: "x",
      });
      expect(parsed.action).toBe(action);
      expect(parsed.strategicIntent).toBe("open_patiently");
      expect(parsed.confidence).toBe(0.8);
      expect(parsed.escalationRequested).toBe(false);
      expect(parsed.settlementReadiness).toBe("not_ready");
    }
  });

  it("rejects an unknown action", () => {
    expect(() =>
      negotiationDecisionSchema.parse({
        action: "nuke",
        price: 1,
        quantity: 1,
        reasoning: "no",
      }),
    ).toThrow();
  });

  it("rejects negative price/quantity", () => {
    expect(() =>
      negotiationDecisionSchema.parse({
        action: "counter",
        price: -1,
        quantity: 1,
        reasoning: "no",
      }),
    ).toThrow();
  });

  it("accepts a minimal move without strategic fields", () => {
    const parsed = negotiationDecisionSchema.parse({
      action: "hold",
      price: 70_000,
      quantity: 1,
      reasoning: "waiting",
    });
    expect(parsed.action).toBe("hold");
    expect(parsed.strategicIntent).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });
});

describe("clampNegotiationDecision — price/quantity bounds", () => {
  it("clamps price above the upper band", () => {
    const out = clampNegotiationDecision(
      {
        action: "propose",
        price: 999_999,
        quantity: 1,
        strategicIntent: "open_patiently",
        confidence: 0.9,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: "ambitious",
      },
      baseCtx,
    );
    expect(out.price).toBeLessThanOrEqual(baseCtx.maxPrice + 0.005);
    expect(out.price).toBeGreaterThan(baseCtx.referencePrice);
    expect(out.strategicIntent).toBe("open_patiently");
    expect(out.confidence).toBe(0.9);
  });

  it("clamps price below the lower band", () => {
    const out = clampNegotiationDecision(
      {
        action: "counter",
        price: 1,
        quantity: 1,
        strategicIntent: "concede",
        reasoning: "lowball",
      },
      baseCtx,
    );
    expect(out.price).toBeGreaterThanOrEqual(baseCtx.minPrice - 0.005);
    expect(out.strategicIntent).toBe("concede");
  });

  it("clamps quantity to the mandate target", () => {
    const out = clampNegotiationDecision(
      {
        action: "propose",
        price: 70_000,
        quantity: 9_999,
        strategicIntent: "test_patience",
        reasoning: "greedy",
      },
      baseCtx,
    );
    expect(out.quantity).toBeLessThanOrEqual(baseCtx.targetQuantity);
  });

  it("shrinks quantity to respect the max notional", () => {
    const tightCtx: NegotiationContext = {
      ...baseCtx,
      maxNotional: 70_000,
    };
    const out = clampNegotiationDecision(
      {
        action: "propose",
        price: 70_000,
        quantity: 10,
        strategicIntent: "open_patiently",
        reasoning: "too big",
      },
      tightCtx,
    );
    expect(out.price * out.quantity).toBeLessThanOrEqual(70_000 + 1);
  });

  it("fills default strategic fields when not provided", () => {
    const out = clampNegotiationDecision(
      {
        action: "propose",
        price: 70_000,
        quantity: 10,
        reasoning: "test",
      },
      baseCtx,
    );
    expect(out.strategicIntent).toBe("open_patiently");
    expect(out.confidence).toBe(0);
    expect(out.escalationRequested).toBe(false);
    expect(out.settlementReadiness).toBe("not_ready");
  });

  it("flags a partial-fill as a trust-building strategic intent", () => {
    const out = clampNegotiationDecision(
      {
        action: "propose",
        price: 70_000,
        quantity: 1,
        reasoning: "smaller block to build trust",
      },
      baseCtx,
    );
    expect(out.strategicIntent).toBe("build_trust");
  });
});

describe("clampNegotiationDecision — disclosure moves", () => {
  // Disclosure moves should happen after the counterpart has put a
  // priced proposal on the table; otherwise the shared validator
  // downgrades them to `propose` on the opening turn. Mirror that
  // here so the agent-side clamp matches the orchestrator's bounds.
  const postOpeningCtx: NegotiationContext = {
    ...baseCtx,
    counterpartStandingPrice: 70_300,
    counterpartStandingQuantity: 1,
    roundNumber: 2,
  };

  it("keeps a reveal when the claim is disclosable", () => {
    const out = clampNegotiationDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "settlement_capacity",
        strategicIntent: "build_trust",
        confidence: 0.7,
        escalationRequested: false,
        settlementReadiness: "near",
        reasoning: "build trust",
      },
      postOpeningCtx,
    );
    expect(out.action).toBe("reveal");
    expect(out.claimType).toBe("settlement_capacity");
    expect(out.strategicIntent).toBe("build_trust");
    expect(out.confidence).toBe(0.7);
  });

  it("falls back to the first disclosable claim when an invalid claim is requested", () => {
    const out = clampNegotiationDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "not_in_allowlist",
        strategicIntent: "build_trust",
        reasoning: "oops",
      },
      postOpeningCtx,
    );
    expect(out.action).toBe("reveal");
    expect(out.claimType).toBe(postOpeningCtx.disclosableClaims[0]);
  });

  it("downgrades reveal to hold when nothing is disclosable", () => {
    const noClaims: NegotiationContext = {
      ...postOpeningCtx,
      disclosableClaims: [],
    };
    const out = clampNegotiationDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        reasoning: "nothing to show",
      },
      noClaims,
    );
    expect(out.action).toBe("hold");
  });

  it("keeps request_disclosure for a required claim", () => {
    const out = clampNegotiationDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        strategicIntent: "request_proof",
        confidence: 0.6,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: "prove it",
      },
      postOpeningCtx,
    );
    expect(out.action).toBe("request_disclosure");
    expect(out.claimType).toBe("accredited_institution");
    expect(out.strategicIntent).toBe("request_proof");
  });

  it("downgrades request_disclosure to hold when nothing is required", () => {
    const noReq: NegotiationContext = { ...postOpeningCtx, requiredClaims: [] };
    const out = clampNegotiationDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        reasoning: "ask",
      },
      noReq,
    );
    expect(out.action).toBe("hold");
  });

  it("downgrades opening-turn reveal to propose", () => {
    const out = clampNegotiationDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "disclose first",
      },
      baseCtx,
    );
    expect(out.action).toBe("propose");
  });

  it("downgrades opening-turn request_disclosure to propose", () => {
    const out = clampNegotiationDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "verify first",
      },
      baseCtx,
    );
    expect(out.action).toBe("propose");
  });

  it("downgrades a second request_disclosure of the same claim to propose", () => {
    const repeatedCtx: NegotiationContext = {
      ...postOpeningCtx,
      priorClaimRequests: ["accredited_institution"],
    };
    const out = clampNegotiationDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "ask again",
      },
      repeatedCtx,
    );
    expect(out.action).toBe("propose");
  });
});

describe("clampNegotiationDecision — walkaway", () => {
  it("zeroes price and quantity on walkaway", () => {
    const out = clampNegotiationDecision(
      {
        action: "walkaway",
        price: 70_000,
        quantity: 1,
        strategicIntent: "walkaway",
        confidence: 0.0,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: "no deal",
      },
      baseCtx,
    );
    expect(out.action).toBe("walkaway");
    expect(out.price).toBe(0);
    expect(out.quantity).toBe(0);
    expect(out.strategicIntent).toBe("walkaway");
    expect(out.confidence).toBe(0);
  });
});
