import { describe, expect, it } from "vitest";
import {
  GUARDED_DEMO_CLAIM,
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

describe("selectGuardedNegotiationMove — settlement_capacity guard", () => {
  it("never emits settlement_capacity at runtime", () => {
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
    expect(result.decision.action).toBe("propose");
    expect(result.decision.claimType).toBeUndefined();
    expect(result.overrideReason).toBe("never_emit_settlement_capacity");
  });

  it("never reveals settlement_capacity at runtime", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: "settlement_capacity",
        reasoning: "Show our settlement capacity",
      }),
    });
    expect(result.decision.action).toBe("propose");
    expect(result.decision.claimType).toBeUndefined();
    expect(result.overrideReason).toBe("never_emit_settlement_capacity");
  });
});

describe("selectGuardedNegotiationMove — disclosure cap", () => {
  it("requests accredited_institution at most once", () => {
    const firstRequest = selectGuardedNegotiationMove({
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
    expect(firstRequest.decision.action).toBe("request_disclosure");
    expect(firstRequest.decision.claimType).toBe(GUARDED_DEMO_CLAIM);
    expect(firstRequest.overrideReason).toBe(
      "replaced_with_request_accredited_institution",
    );

    const secondRequest = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        priorRequests: [GUARDED_DEMO_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "request_disclosure",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Ask again",
      }),
    });
    expect(secondRequest.decision.action).toBe("propose");
    expect(secondRequest.decision.claimType).toBeUndefined();
    expect(secondRequest.overrideReason).toBe("replaced_with_propose");
  });

  it("reveals accredited_institution at most once before proposing", () => {
    const reveal = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Reciprocal reveal",
      }),
    });
    expect(reveal.decision.action).toBe("reveal");
    expect(reveal.decision.claimType).toBe(GUARDED_DEMO_CLAIM);
    expect(reveal.overrideReason).toBe(
      "replaced_with_reveal_accredited_institution",
    );
  });

  it("does not reveal accredited_institution a second time once priorReveals is set", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_100,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM],
        priorReveals: [GUARDED_DEMO_CLAIM],
      }),
      llmDecision: llmPropose({
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        reasoning: "Re-reveal",
      }),
    });
    // After both sides have already exchanged the claim, the move
    // must be an accept (not another reveal). The guard's purpose
    // is to make sure we don't loop on disclosure — and the test
    // verifies the LLM's redundant reveal gets converted into the
    // right terminal action.
    expect(result.decision.action).toBe("accept");
    expect(result.decision.price).toBe(70_100);
    expect(result.decision.quantity).toBe(1);
    expect(result.overrideReason).toBe("replaced_with_accept");
  });
});

describe("selectGuardedNegotiationMove — accept cross", () => {
  it("accepts at counterpart standing terms when both sides have verified the demo claim", () => {
    const result = selectGuardedNegotiationMove({
      bounds,
      ctx: freshCtx({
        counterpartHasStandingTerms: true,
        counterpartStandingPrice: 70_080,
        counterpartStandingQuantity: 1,
        receivedClaims: [GUARDED_DEMO_CLAIM],
        priorReveals: [GUARDED_DEMO_CLAIM],
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