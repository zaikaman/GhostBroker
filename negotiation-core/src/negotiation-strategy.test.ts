import { describe, expect, it } from "vitest";
import {
  buildTurnContext,
  derivedPriceBandFor,
  deriveExecutionRails,
  disclosureGateSatisfied,
  normalizeStrategy,
  pairingCompatibility,
  preferredEnvelopeFor,
  priceInsidePreferredEnvelope,
  validateAgentDecision,
  type AuthoredMandatePolicy,
} from "./negotiation-strategy.js";

const buyerAuthored: AuthoredMandatePolicy = {
  objective: "Acquire strategic BTC exposure quietly",
  assetCode: "WBTC",
  side: "buy",
  sizePolicy: { targetQuantity: 1, minimumQuantity: 0.5, partialExecutionAllowed: true },
  urgency: "normal",
  executionStyle: "balanced",
  valuationPolicy: { source: "operator_note", anchorValue: 70_000 },
  concessionPolicy: { pace: "balanced", maxConcessionBps: 150 },
  disclosurePolicy: {
    allowLadder: ["accredited_institution", "settlement_capacity"],
    requireReciprocityFor: ["settlement_capacity"],
  },
  counterpartyRequirements: {
    requiredClaims: ["accredited_institution", "settlement_capacity"],
    disallowedTraits: [],
  },
  approvalPolicy: {
    mode: "escalate_outside_envelope",
    preferredEnvelopeNote: "Stay inside the half-band",
  },
  timeWindow: { deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  operatorInstructions: "Be patient.",
};

const sellerAuthored: AuthoredMandatePolicy = {
  ...buyerAuthored,
  side: "sell",
  executionStyle: "aggressive",
};

function buildProfile(authored: AuthoredMandatePolicy) {
  return normalizeStrategy(authored);
}

describe("deriveExecutionRails", () => {
  it("computes a symmetric walk-away band around the anchor", () => {
    const rails = deriveExecutionRails(buyerAuthored);
    expect(rails.referencePrice).toBe(70_000);
    expect(rails.walkawayMin).toBeLessThan(70_000);
    expect(rails.walkawayMax).toBeGreaterThan(70_000);
    expect(rails.targetQuantity).toBe(1);
    expect(rails.partialExecutionAllowed).toBe(true);
  });
});

describe("derivedPriceBandFor", () => {
  it("returns anchor..walkawayMax for buyer and walkawayMin..anchor for seller", () => {
    const rails = deriveExecutionRails(buyerAuthored);
    expect(derivedPriceBandFor(rails, "buy")).toEqual({
      minPrice: rails.referencePrice,
      maxPrice: rails.walkawayMax,
    });
    expect(derivedPriceBandFor(rails, "sell")).toEqual({
      minPrice: rails.walkawayMin,
      maxPrice: rails.referencePrice,
    });
  });
});

describe("preferredEnvelopeFor", () => {
  it("is a half-band centered on the anchor", () => {
    const profile = buildProfile(buyerAuthored);
    const envelope = preferredEnvelopeFor(profile, "buy");
    expect(envelope.minPrice).toBe(profile.rails.referencePrice);
    expect(envelope.maxPrice).toBeLessThanOrEqual(profile.rails.walkawayMax);
    expect(envelope.maxPrice).toBeGreaterThan(profile.rails.referencePrice);
  });
});

describe("priceInsidePreferredEnvelope", () => {
  it("treats anchor as inside, far-band as outside", () => {
    const profile = buildProfile(buyerAuthored);
    expect(priceInsidePreferredEnvelope(profile, "buy", profile.rails.referencePrice)).toBe(true);
    expect(priceInsidePreferredEnvelope(profile, "buy", profile.rails.walkawayMax + 1)).toBe(false);
  });
});

describe("buildTurnContext", () => {
  it("mirrors derived bounds and surfaces the preferred envelope", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 2,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "near",
      counterpartStandingPrice: 70_500,
      counterpartStandingQuantity: 1,
      receivedClaims: ["accredited_institution"],
      concessionConsumedBps: 30,
    });
    expect(ctx.referencePrice).toBe(profile.rails.referencePrice);
    expect(ctx.minPrice).toBe(profile.rails.referencePrice);
    expect(ctx.maxPrice).toBe(profile.rails.walkawayMax);
    expect(ctx.preferredMinPrice).toBe(profile.rails.referencePrice);
    expect(ctx.preferredMaxPrice).toBeGreaterThan(profile.rails.referencePrice);
    expect(ctx.requiredClaims).toEqual([
      "accredited_institution",
      "settlement_capacity",
    ]);
    expect(ctx.trustLevel).toBe("partial");
  });

  it("marks trust established when every required claim is verified", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 3,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "crossed",
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: ["accredited_institution", "settlement_capacity"],
      concessionConsumedBps: 0,
    });
    expect(ctx.trustLevel).toBe("established");
  });

  it("treats no required claims as established from round one", () => {
    const openMandate: AuthoredMandatePolicy = {
      ...buyerAuthored,
      counterpartyRequirements: {
        requiredClaims: [],
        disallowedTraits: [],
      },
    };
    const profile = buildProfile(openMandate);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: openMandate.timeWindow.deadline,
      distanceSignal: null,
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    expect(ctx.trustLevel).toBe("established");
  });
});

describe("validateAgentDecision", () => {
  it("clamps price above the band into the rail", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
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
    });
    const result = validateAgentDecision(
      {
        action: "propose",
        price: 999_999,
        quantity: 1,
        reasoning: "ambitious",
      },
      ctx,
    );
    expect(result.accepted.price).toBeLessThanOrEqual(ctx.maxPrice);
    expect(result.accepted.action).toBe("propose");
  });

  it("forces escalation when the priced exit leaves the preferred envelope", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "near",
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "counter",
        price: profile.rails.walkawayMax,
        quantity: 1,
        reasoning: "push the edge",
      },
      ctx,
    );
    expect(result.accepted.escalationRequested).toBe(true);
  });

  it("does not force escalation inside the preferred envelope", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "near",
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "propose",
        price: profile.rails.referencePrice,
        quantity: 1,
        reasoning: "open at the anchor",
      },
      ctx,
    );
    expect(result.accepted.escalationRequested).toBe(false);
  });

  it("surfaces a partial-fill as a trust-building strategic intent", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 2,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "near",
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "propose",
        price: profile.rails.referencePrice,
        quantity: 0.5,
        reasoning: "smaller block to build trust",
      },
      ctx,
    );
    expect(result.accepted.strategicIntent).toBe("build_trust");
  });

  it("downgrades reveal when nothing is disclosable", () => {
    const noClaimsMandate: AuthoredMandatePolicy = {
      ...buyerAuthored,
      disclosurePolicy: { allowLadder: [] },
    };
    const profile = buildProfile(noClaimsMandate);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: noClaimsMandate.timeWindow.deadline,
      distanceSignal: null,
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "reveal",
        price: profile.rails.referencePrice,
        quantity: 1,
        reasoning: "nothing to show",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("hold");
    expect(result.downgradedFrom).toBe("reveal");
  });

  it("downgrades opening-turn request_disclosure to propose", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: null,
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "verify counterpart first",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("propose");
    expect(result.downgradedFrom).toBe("request_disclosure");
    expect(result.adjustedReason).toBe("opening_turn_must_propose");
    expect(result.accepted.price).toBeGreaterThan(0);
  });

  it("downgrades opening-turn reveal to propose", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: null,
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "disclose first",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("propose");
    expect(result.downgradedFrom).toBe("reveal");
    expect(result.adjustedReason).toBe("opening_turn_must_propose");
  });

  it("keeps request_disclosure after the counterpart has already proposed", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 2,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "moderate",
      counterpartStandingPrice: 70_500,
      counterpartStandingQuantity: 1,
      receivedClaims: [],
      concessionConsumedBps: 30,
    });
    const result = validateAgentDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "verify counterpart",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("request_disclosure");
    expect(result.downgradedFrom).toBeUndefined();
  });

  it("downgrades a second request_disclosure of the same claim to propose", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 3,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "moderate",
      counterpartStandingPrice: 70_500,
      counterpartStandingQuantity: 1,
      receivedClaims: [],
      concessionConsumedBps: 30,
      priorClaimRequests: ["accredited_institution"],
    });
    const result = validateAgentDecision(
      {
        action: "request_disclosure",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "ask again",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("propose");
    expect(result.downgradedFrom).toBe("request_disclosure");
    expect(result.adjustedReason).toBe("repeated_disclosure_request");
  });

  it("downgrades a third reveal of the same claim to propose", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 4,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: "moderate",
      counterpartStandingPrice: 70_500,
      counterpartStandingQuantity: 1,
      receivedClaims: [],
      concessionConsumedBps: 30,
      priorClaimRequests: ["accredited_institution", "accredited_institution"],
    });
    const result = validateAgentDecision(
      {
        action: "reveal",
        price: 70_000,
        quantity: 1,
        claimType: "accredited_institution",
        reasoning: "reveal again",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("propose");
    expect(result.downgradedFrom).toBe("reveal");
    expect(result.adjustedReason).toBe("repeated_disclosure_reveal");
  });

  it("zeroes price and quantity on walkaway", () => {
    const profile = buildProfile(buyerAuthored);
    const ctx = buildTurnContext({
      profile,
      side: "buy",
      roundNumber: 1,
      maxRounds: 12,
      deadline: profile.authored.timeWindow.deadline,
      distanceSignal: null,
      counterpartStandingPrice: null,
      counterpartStandingQuantity: null,
      receivedClaims: [],
      concessionConsumedBps: 0,
    });
    const result = validateAgentDecision(
      {
        action: "walkaway",
        price: 70_000,
        quantity: 1,
        reasoning: "no deal",
      },
      ctx,
    );
    expect(result.accepted.action).toBe("walkaway");
    expect(result.accepted.price).toBe(0);
    expect(result.accepted.quantity).toBe(0);
  });
});

describe("pairingCompatibility", () => {
  it("returns compatible for opposing sides with overlapping size regime", () => {
    const buyer = buildProfile(buyerAuthored);
    const seller = buildProfile(sellerAuthored);
    const compat = pairingCompatibility(buyer, seller);
    expect(compat.compatible).toBe(true);
  });

  it("flags size floor violations when partial fills are forbidden", () => {
    const fullBlockBuyer: AuthoredMandatePolicy = {
      ...buyerAuthored,
      sizePolicy: {
        targetQuantity: 2,
        minimumQuantity: 2,
        partialExecutionAllowed: false,
      },
    };
    const smallSeller: AuthoredMandatePolicy = {
      ...sellerAuthored,
      sizePolicy: {
        targetQuantity: 0.5,
        minimumQuantity: 0.25,
        partialExecutionAllowed: true,
      },
    };
    const compat = pairingCompatibility(
      buildProfile(fullBlockBuyer),
      buildProfile(smallSeller),
    );
    expect(compat.compatible).toBe(false);
    expect(compat.reasons).toContain("buyer_size_floor_unmet");
  });

  it("flags asset mismatches", () => {
    const otherAsset: AuthoredMandatePolicy = { ...sellerAuthored, assetCode: "WETH" };
    const compat = pairingCompatibility(
      buildProfile(buyerAuthored),
      buildProfile(otherAsset),
    );
    expect(compat.compatible).toBe(false);
    expect(compat.reasons).toContain("asset_mismatch");
  });
});

describe("disclosureGateSatisfied", () => {
  it("treats an empty required set as satisfied", () => {
    expect(
      disclosureGateSatisfied({
        requiredClaims: [],
        receivedVerifiedClaims: [],
      }),
    ).toBe(true);
  });

  it("requires every required claim to be verified", () => {
    expect(
      disclosureGateSatisfied({
        requiredClaims: ["a", "b"],
        receivedVerifiedClaims: ["a"],
      }),
    ).toBe(false);
    expect(
      disclosureGateSatisfied({
        requiredClaims: ["a", "b"],
        receivedVerifiedClaims: ["a", "b"],
      }),
    ).toBe(true);
  });
});