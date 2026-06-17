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
  targetQuantity: 10,
  referencePrice: 70_000,
  priceBandBps: 200,
  minPrice: 70_000 * 0.98,
  maxPrice: 70_000 * 1.02,
  maxNotional: 1_000_000,
  urgency: "normal",
  roundNumber: 1,
  maxRounds: 12,
  distanceSignal: "moderate",
  counterpartStandingPrice: null,
  counterpartStandingQuantity: null,
  disclosableClaims: ["accredited_institution", "settlement_capacity"],
  receivedClaims: [],
  requiredClaims: ["accredited_institution"],
  operatorPrompt: undefined,
  lastOutcome: undefined,
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
        reasoning: "x",
      });
      expect(parsed.action).toBe(action);
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
});

describe("clampNegotiationDecision — price/quantity bounds", () => {
  it("clamps price above the upper band", () => {
    const out = clampNegotiationDecision(
      { action: "propose", price: 999_999, quantity: 1, reasoning: "ambitious" },
      baseCtx,
    );
    expect(out.price).toBeLessThanOrEqual(baseCtx.maxPrice + 0.005);
    expect(out.price).toBeGreaterThan(baseCtx.referencePrice);
  });

  it("clamps price below the lower band", () => {
    const out = clampNegotiationDecision(
      { action: "counter", price: 1, quantity: 1, reasoning: "lowball" },
      baseCtx,
    );
    expect(out.price).toBeGreaterThanOrEqual(baseCtx.minPrice - 0.005);
  });

  it("clamps quantity to the mandate target", () => {
    const out = clampNegotiationDecision(
      { action: "propose", price: 70_000, quantity: 9_999, reasoning: "greedy" },
      baseCtx,
    );
    expect(out.quantity).toBeLessThanOrEqual(baseCtx.targetQuantity);
  });

  it("shrinks quantity to respect the max notional", () => {
    const tightCtx: NegotiationContext = { ...baseCtx, maxNotional: 70_000 };
    const out = clampNegotiationDecision(
      { action: "propose", price: 70_000, quantity: 10, reasoning: "too big" },
      tightCtx,
    );
    expect(out.price * out.quantity).toBeLessThanOrEqual(70_000 + 1);
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
        reasoning: "build trust",
      },
      baseCtx,
    );
    expect(out.action).toBe("reveal");
    expect(out.claimType).toBe("settlement_capacity");
  });

  it("falls back to the first disclosable claim when an invalid claim is requested", () => {
    const out = clampNegotiationDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "not_in_allowlist",
        reasoning: "oops",
      },
      baseCtx,
    );
    expect(out.action).toBe("reveal");
    expect(out.claimType).toBe(baseCtx.disclosableClaims[0]);
  });

  it("downgrades reveal to hold when nothing is disclosable", () => {
    const noClaims: NegotiationContext = { ...baseCtx, disclosableClaims: [] };
    const out = clampNegotiationDecision(
      { action: "reveal", price: 70_000, quantity: 1, reasoning: "nothing to show" },
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
        reasoning: "prove it",
      },
      baseCtx,
    );
    expect(out.action).toBe("request_disclosure");
    expect(out.claimType).toBe("accredited_institution");
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
      { action: "walkaway", price: 70_000, quantity: 1, reasoning: "no deal" },
      baseCtx,
    );
    expect(out.action).toBe("walkaway");
    expect(out.price).toBe(0);
    expect(out.quantity).toBe(0);
  });
});
