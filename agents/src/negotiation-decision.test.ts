import { describe, expect, it } from "vitest";
import {
  clampNegotiationDecision,
  negotiationDecisionSchema,
} from "./negotiation-decision.js";
import type { NegotiationContext } from "./negotiation-decision.js";

const baseCtx: NegotiationContext = {
  side: "buy",
  assetCode: "WBTC",
  quoteAssetCode: "USDC",
  objective: "Acquire strategic BTC exposure",
  executionStyle: "balanced",
  urgency: "normal",
  targetQuantity: 10,
  minimumQuantity: 1,
  partialExecutionAllowed: true,
  referencePrice: 70_000,
  minPrice: 70_000,
  maxPrice: 70_000 * 1.02,
  maxNotional: 1_000_000,
  concessionBudgetRemainingBps: 200,
  roundNumber: 1,
  maxRounds: 12,
  roundsRemaining: 11,
  deadline: new Date(Date.now() + 86_400_000).toISOString(),
  timeToDeadlineMs: 86_400_000,
  distanceSignal: "moderate",
  counterpartPattern: "unknown",
  counterpartStandingPrice: null,
  counterpartStandingQuantity: null,
  disclosableClaims: ["accredited_institution", "settlement_capacity"],
  receivedClaims: [],
  requiredClaims: ["accredited_institution"],
  trustLevel: "none",
  approvalMode: "auto_settle",
  operatorInstructions: "Be patient but get the deal done.",
  lastOutcome: undefined,
  priorMoveRationale: undefined,
};

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
      { action: "propose", price: 70_000, quantity: 1, reasoning: "test" },
      baseCtx,
    );
    expect(out.strategicIntent).toBe("open_patiently");
    expect(out.confidence).toBe(0);
    expect(out.escalationRequested).toBe(false);
    expect(out.settlementReadiness).toBe("not_ready");
  });
});

describe("clampNegotiationDecision — disclosure moves", () => {
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
      baseCtx,
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
      baseCtx,
    );
    expect(out.action).toBe("reveal");
    expect(out.claimType).toBe(baseCtx.disclosableClaims[0]);
  });

  it("downgrades reveal to hold when nothing is disclosable", () => {
    const noClaims: NegotiationContext = {
      ...baseCtx,
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
      baseCtx,
    );
    expect(out.action).toBe("request_disclosure");
    expect(out.claimType).toBe("accredited_institution");
    expect(out.strategicIntent).toBe("request_proof");
  });

  it("downgrades request_disclosure to hold when nothing is required", () => {
    const noReq: NegotiationContext = { ...baseCtx, requiredClaims: [] };
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
