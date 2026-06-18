import { describe, expect, it } from "vitest";
import {
  GUARDED_DEMO_CLAIM,
  GUARDED_SECONDARY_CLAIM,
  selectGuardedNegotiationMove,
  type GuardedNegotiationContext,
} from "./guarded-protocol.js";
import type { NegotiationDecision } from "./negotiation-decision.js";

const bounds = {
  minPrice: 70_000,
  maxPrice: 70_150,
  targetQuantity: 1,
  minimumQuantity: 1,
};

function llmPropose(overrides: Partial<NegotiationDecision> = {}): NegotiationDecision {
  return {
    action: "propose",
    price: 70_050,
    quantity: 1,
    strategicIntent: "open_patiently",
    confidence: 0.8,
    escalationRequested: false,
    settlementReadiness: "not_ready",
    reasoning: "Open at the anchor.",
    ...overrides,
  };
}

function freshCtx(
  overrides: Partial<GuardedNegotiationContext> = {},
): GuardedNegotiationContext {
  return {
    side: "buy",
    counterpartHasStandingTerms: false,
    counterpartStandingPrice: null,
    counterpartStandingQuantity: null,
    receivedClaims: [],
    priorReveals: [],
    priorRequests: [],
    settlementCapacityPreCleared: true,
    ...overrides,
  };
}

describe("selectGuardedNegotiationMove — opening turn", () => {
  it("always proposes on the opening turn", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose(),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.overrideReason).toBe("preserved_llm_decision");
  });

  it("downgrades an opening-turn reveal to propose", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Disclose first",
      }),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.overrideReason).toBe("replaced_with_propose");
  });

  it("downgrades an opening-turn request_disclosure to propose", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({
        action: "request_disclosure",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Ask first",
      }),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.overrideReason).toBe("replaced_with_propose");
  });
});

describe("selectGuardedNegotiationMove — disclosure choreography", () => {
  it("reveals accredited_institution on the first turn after opening", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
      }),
      llmDecision: llmPropose({
        action: "request_disclosure",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Ask once",
      }),
    });
    expect(result.decision.action).toBe("reveal");
    expect(result.decision.claimType).toBe(GUARDED_DEMO_CLAIM);
    expect(result.overrideReason).toBe(
      "replaced_with_reveal_accredited_institution",
    );
  });

  it("reveals settlement_capacity after accredited_institution has been revealed", () => {
    // We've revealed accredited_institution but NOT settlement_capacity
    // Step 3 should fire: reveal settlement_capacity
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        priorReveals: [GUARDED_DEMO_CLAIM],
        receivedClaims: [GUARDED_DEMO_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "request_disclosure",
        claimType: "settlement_capacity",
        reasoning: "Check their settlement capacity",
      }),
    });
    expect(result.decision.action).toBe("reveal");
    expect(result.decision.claimType).toBe(GUARDED_SECONDARY_CLAIM);
    expect(result.overrideReason).toBe(
      "replaced_with_reveal_settlement_capacity",
    );
  });

  it("accepts when both sides have exchanged both claims", () => {
    // Both claims revealed by us AND verified by counterpart
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        priorReveals: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
        receivedClaims: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Re-reveal",
      }),
    });
    expect(result.decision.action).toBe("accept");
    expect(result.decision.price).toBe(70_100);
    expect(result.decision.quantity).toBe(1);
    expect(result.overrideReason).toBe("replaced_with_accept");
  });

  it("restates terms after both claims revealed but counterpart hasn't verified secondary yet", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        priorReveals: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
        receivedClaims: [GUARDED_DEMO_CLAIM], // secondary NOT yet verified
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Re-reveal",
      }),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.decision.claimType).toBeUndefined();
    expect(result.overrideReason).toBe("replaced_with_propose");
  });

  it("reveals when counterpart has already verified us but we haven't revealed yet", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Reciprocal reveal",
      }),
    });
    expect(result.decision.action).toBe("reveal");
    expect(result.decision.claimType).toBe(GUARDED_DEMO_CLAIM);
    expect(result.overrideReason).toBe(
      "replaced_with_reveal_accredited_institution",
    );
  });
});

describe("selectGuardedNegotiationMove — accept cross", () => {
  it("accepts at counterpart standing terms when both claims are verified", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_080,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
        priorReveals: [GUARDED_DEMO_CLAIM, GUARDED_SECONDARY_CLAIM],
      }),
      llmDecision: llmPropose(),
    });
    expect(result.decision.action).toBe("accept");
    expect(result.decision.price).toBe(70_080);
    expect(result.decision.quantity).toBe(1);
    expect(result.decision.settlementReadiness).toBe("ready");
    expect(result.overrideReason).toBe("replaced_with_accept");
  });

  it("preserves LLM price/rationale where it does not conflict with the protocol", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({
        price: 70_030,
        quantity: 1,
        strategicIntent: "open_patiently",
        confidence: 0.9,
        reasoning: "I want to bid 70,030 to leave room.",
      }),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.decision.price).toBe(70_030);
    expect(result.decision.confidence).toBe(0.9);
    expect(result.decision.reasoning).toBe("I want to bid 70,030 to leave room.");
  });

  it("clamps an LLM price above the upper band on the opening turn", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({ price: 999_999 }),
    });
    expect(result.decision.price).toBeLessThanOrEqual(bounds.maxPrice);
  });

  it("falls back to target quantity when the LLM omits one", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({ quantity: 0 }),
    });
    expect(result.decision.quantity).toBe(bounds.targetQuantity);
  });
});

describe("selectGuardedNegotiationMove — walkaway passthrough", () => {
  it("does not override a walkaway on the opening turn", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx(),
      llmDecision: llmPropose({
        action: "walkaway",
        price: 0,
        quantity: 0,
        reasoning: "Bad terms",
      }),
    });
    expect(result.decision.action).toBe("walkaway");
    expect(result.overrideReason).toBe("preserved_llm_decision");
  });
});
