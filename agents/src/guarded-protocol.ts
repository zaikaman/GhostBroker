import type { NegotiationDecision } from "./negotiation-decision.js";

/**
 * The minimal input the guarded selector needs. Mirrors the
 * RedactedNegotiationSessionView bits the agent loop already keeps
 * track of, plus the LLM-proposed decision. Extracted into its own
 * type so the helper is unit-testable without a live LLM.
 */
export interface GuardedNegotiationContext {
  /** This side. */
  side: "buy" | "sell";
  /** Whether the counterpart has put a priced proposal on the table. */
  counterpartHasStandingTerms: boolean;
  /** Counterpart's standing price (only meaningful when counterpartHasStandingTerms). */
  counterpartStandingPrice: number | null;
  /** Counterpart's standing quantity (only meaningful when counterpartHasStandingTerms). */
  counterpartStandingQuantity: number | null;
  /** Claim types the counterpart has already verified for THIS side. */
  receivedClaims: readonly string[];
  /** Claim types THIS side has already revealed on previous rounds. */
  priorReveals: readonly string[];
  /** Claim types THIS side has already requested from the counterpart. */
  priorRequests: readonly string[];
  /** Whether `settlement_capacity` has already been pre-cleared for both sides. */
  settlementCapacityPreCleared: boolean;
}

export interface GuardedSelectorInput {
  /** Bounds the move must stay inside (price band, target quantity). */
  bounds: {
    minPrice: number;
    maxPrice: number;
    targetQuantity: number;
    minimumQuantity: number;
  };
  /** Live session state. */
  ctx: GuardedNegotiationContext;
  /** The LLM's proposed move. Honoured where it does not break the
   * guarded protocol — the helper overrides only when the protocol
   * dictates a specific action (e.g. the LLM asked for
   * `settlement_capacity`, which is never permitted). */
  llmDecision: NegotiationDecision;
}

/**
 * What `selectGuardedNegotiationMove` adjusted on the LLM's proposed
 * move, if anything. Surfaced so the agent loop can log
 * `guarded_fast override: <from> -> <to>` per the demo narrative.
 */
export type GuardedOverrideReason =
  | "never_emit_settlement_capacity"
  | "replaced_with_reveal_accredited_institution"
  | "replaced_with_reveal_settlement_capacity"
  | "replaced_with_propose"
  | "replaced_with_accept"
  | "preserved_llm_decision";

export interface GuardedSelectorResult {
  decision: NegotiationDecision;
  overrideReason: GuardedOverrideReason;
}

/**
 * The first claim the guarded protocol reveals.
 */
export const GUARDED_DEMO_CLAIM = "accredited_institution";

/**
 * The second claim the guarded protocol reveals — after
 * `accredited_institution` has been exchanged, the guard reveals
 * `settlement_capacity` so the disclosure gate on the orchestrator
 * can clear. The mandate requires both claims, and without this
 * step the guard would block `settlement_capacity` forever, making
 * settlement impossible.
 */
export const GUARDED_SECONDARY_CLAIM = "settlement_capacity";

/**
 * Return true when the LLM's `claimType` would have asked for (or
 * revealed) a claim the guarded protocol forbids. The guard allows:
 *   - `accredited_institution` (revealed first)
 *   - `settlement_capacity` (revealed second, after the first clears)
 *   - `undefined` (no claim — priced move like propose/accept)
 * Everything else is blocked.
 */
function claimTypeForbiddenInGuarded(claimType: string | undefined): boolean {
  if (claimType === undefined) return false;
  if (claimType === GUARDED_DEMO_CLAIM) return false;
  if (claimType === GUARDED_SECONDARY_CLAIM) return false;
  return true;
}

/**
 * True when THIS side has already revealed a given claim type
 * on a prior round.
 */
function hasRevealedClaim(
  priorReveals: readonly string[],
  claimType: string,
): boolean {
  return priorReveals.includes(claimType);
}

/**
 * True when THIS side has already revealed `accredited_institution`.
 */
function hasRevealedDemoClaim(priorReveals: readonly string[]): boolean {
  return hasRevealedClaim(priorReveals, GUARDED_DEMO_CLAIM);
}

/**
 * True when the counterpart has already verified a given claim type
 * for THIS side.
 */
function counterpartClaimVerifiedFor(
  receivedClaims: readonly string[],
  claimType: string,
): boolean {
  return receivedClaims.includes(claimType);
}

/**
 * True when the counterpart has already verified
 * `accredited_institution` for THIS side.
 */
function counterpartClaimVerified(
  receivedClaims: readonly string[],
): boolean {
  return counterpartClaimVerifiedFor(receivedClaims, GUARDED_DEMO_CLAIM);
}

/**
 * True when the counterpart has already verified
 * `settlement_capacity` for THIS side.
 */
function counterpartSecondaryClaimVerified(
  receivedClaims: readonly string[],
): boolean {
  return counterpartClaimVerifiedFor(receivedClaims, GUARDED_SECONDARY_CLAIM);
}

/**
 * Clamp an LLM-supplied price into the agent's mandate band. Returns
 * `null` when the LLM did not propose a usable number.
 */
function clampGuardedPrice(
  rawPrice: number | undefined,
  bounds: GuardedSelectorInput["bounds"],
): number | null {
  if (rawPrice === undefined) return null;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return null;
  return Math.max(bounds.minPrice, Math.min(bounds.maxPrice, rawPrice));
}

/**
 * Clamp an LLM-supplied quantity into the agent's
 * [minimumQuantity, targetQuantity] window. Returns `null` when the
 * LLM did not propose a usable number.
 */
function clampGuardedQuantity(
  rawQuantity: number | undefined,
  bounds: GuardedSelectorInput["bounds"],
): number | null {
  if (rawQuantity === undefined) return null;
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return null;
  return Math.max(
    bounds.minimumQuantity,
    Math.min(bounds.targetQuantity, rawQuantity),
  );
}

/**
 * Pick the value for the `propose` / `accept` / `reveal` /
 * `request_disclosure` action. The LLM's price / quantity are
 * honoured inside the band so its strategic intent still shows in
 * the log; missing or out-of-band values fall back to the supplied
 * `fallback` (which the caller picks from the counterpart's
 * standing proposal or from the band's edge).
 */
function pickGuardedPrice(
  llmDecision: NegotiationDecision,
  bounds: GuardedSelectorInput["bounds"],
  fallback: number,
): number {
  return clampGuardedPrice(llmDecision.price, bounds) ?? fallback;
}

function pickGuardedQuantity(
  llmDecision: NegotiationDecision,
  bounds: GuardedSelectorInput["bounds"],
  fallback: number,
): number {
  return clampGuardedQuantity(llmDecision.quantity, bounds) ?? fallback;
}

/**
 * The deterministic choreography the guarded fast-path uses.
 *
 * The selector takes the LLM's `llmDecision` and reshapes it into
 * the next move the loop should submit. The LLM's price / quantity
 * / strategic intent / reasoning are preserved where safe; the
 * `action` and `claimType` are owned by the helper so the demo
 * cannot get stuck in repeated disclosure loops or spend rounds
 * asking for `settlement_capacity`.
 *
 * Precedence:
 *
 *   1. Opening turn (counterpart has no standing terms):
 *      always `propose`, even when the LLM tried to disclose.
 *
 *   2. THIS side has not yet revealed `accredited_institution`:
 *      `reveal` with the first demo claim. Comes before the
 *      counterpart claim check so at least one side makes the
 *      first reveal (breaking the request-then-loop-deadlock).
 *
 *   3. THIS side HAS revealed `accredited_institution` but has NOT
 *      yet revealed `settlement_capacity`: `reveal` with the
 *      secondary claim. The mandate requires both claims for the
 *      disclosure gate to clear; without this step the guard would
 *      block `settlement_capacity` and settlement would be
 *      permanently stuck.
 *
 *   4. Both required claims are verified by the counterpart AND
 *      counterpart has standing terms: `accept` at counterpart
 *      standing price/quantity. This check comes BEFORE the
 *      forbidden-claim guard so that even when the LLM keeps
 *      asking for unrelated claims, once the gate clears we accept.
 *
 *   5. Forbidden claimType: replace with a priced `propose`.
 *      Only reached when step 4 didn't fire.
 *
 *   6. Counterpart has terms but a required claim is not yet
 *      verified: restate priced terms with `propose`.
 *
 *   7. Otherwise: priced `propose` (the LLM's price honoured inside
 *      the band) so the cross stays visible.
 */
export function selectGuardedNegotiationMove(
  input: GuardedSelectorInput,
): GuardedSelectorResult {
  const { bounds, ctx, llmDecision } = input;

  // Walkaway is a no-rail terminal action: it is preserved
  // verbatim regardless of where we are in the choreography.
  // The shared validator (and the agent loop's
  // `submitNegotiationMove` path) already zero price/quantity
  // for walkaway.
  if (llmDecision.action === "walkaway") {
    return {
      decision: {
        action: "walkaway",
        price: 0,
        quantity: 0,
        strategicIntent: llmDecision.strategicIntent ?? "walkaway",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: llmDecision.reasoning,
      },
      overrideReason: "preserved_llm_decision",
    };
  }

  // (1) Opening turn: always `propose`. The LLM still picks the
  // price / strategic intent inside the band.
  if (!ctx.counterpartHasStandingTerms) {
    const price = pickGuardedPrice(llmDecision, bounds, bounds.minPrice);
    const quantity = pickGuardedQuantity(llmDecision, bounds, bounds.targetQuantity);
    const action = llmDecision.action;
    const reason: GuardedOverrideReason =
      action === "propose"
        ? "preserved_llm_decision"
        : "replaced_with_propose";
    return {
      decision: {
        action: "propose",
        price,
        quantity,
        strategicIntent: llmDecision.strategicIntent ?? "open_patiently",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "near",
        reasoning:
          action === "propose"
            ? llmDecision.reasoning
            : "Opening turn requires a priced move; the guarded protocol restates terms.",
      },
      overrideReason: reason,
    };
  }

  // From here on, the counterpart has put a priced proposal on the
  // table. Build the cross path deterministically.
  const counterpartPrice = ctx.counterpartStandingPrice;
  const counterpartQuantity = ctx.counterpartStandingQuantity;

  // (2) Reciprocal gate (our side): if WE have not yet revealed
  // `accredited_institution`, do so now while restating terms.
  // This check comes BEFORE the counterpart claim check so that at
  // least one side makes the first reveal instead of both sides
  // waiting for the other to verify.
  if (!hasRevealedDemoClaim(ctx.priorReveals)) {
    return {
      decision: {
        action: "reveal",
        claimType: GUARDED_DEMO_CLAIM,
        price: pickGuardedPrice(
          llmDecision,
          bounds,
          counterpartPrice ?? bounds.minPrice,
        ),
        quantity: pickGuardedQuantity(
          llmDecision,
          bounds,
          counterpartQuantity ?? bounds.targetQuantity,
        ),
        strategicIntent: llmDecision.strategicIntent ?? "build_trust",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "near",
        reasoning: `Guarded fast-path: revealing ${GUARDED_DEMO_CLAIM} while restating priced terms.`,
      },
      overrideReason: "replaced_with_reveal_accredited_institution",
    };
  }

  // (3) Secondary disclosure step: we've revealed
  // `accredited_institution` but have NOT yet revealed
  // `settlement_capacity`. Reveal it now so the orchestrator's
  // disclosure gate clears. Without this step the gate stays
  // blocked (mandate requires both claims) and settlement never
  // happens.
  if (!hasRevealedClaim(ctx.priorReveals, GUARDED_SECONDARY_CLAIM)) {
    return {
      decision: {
        action: "reveal",
        claimType: GUARDED_SECONDARY_CLAIM,
        price: pickGuardedPrice(
          llmDecision,
          bounds,
          counterpartPrice ?? bounds.minPrice,
        ),
        quantity: pickGuardedQuantity(
          llmDecision,
          bounds,
          counterpartQuantity ?? bounds.targetQuantity,
        ),
        strategicIntent: llmDecision.strategicIntent ?? "build_trust",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "near",
        reasoning:
          "Guarded fast-path: revealing settlement_capacity after accredited_institution cleared.",
      },
      overrideReason: "replaced_with_reveal_settlement_capacity",
    };
  }

  // (4) Both required claims have been verified by the counterpart
  // AND the counterpart has standing terms. Accept at the
  // counterpart's price/quantity. This check comes BEFORE the
  // forbidden-claim guard so that even when the LLM hallucinates,
  // once the gate clears we accept.
  if (
    counterpartClaimVerified(ctx.receivedClaims) &&
    counterpartSecondaryClaimVerified(ctx.receivedClaims) &&
    counterpartPrice !== null &&
    counterpartQuantity !== null &&
    Number.isFinite(counterpartPrice) &&
    Number.isFinite(counterpartQuantity)
  ) {
    return {
      decision: {
        action: "accept",
        price: counterpartPrice,
        quantity: counterpartQuantity,
        strategicIntent: llmDecision.strategicIntent ?? "accept",
        confidence: llmDecision.confidence ?? 1,
        escalationRequested: false,
        settlementReadiness: "ready",
        reasoning:
          "Guarded fast-path: both claims verified; accepting counterpart standing terms.",
      },
      overrideReason: "replaced_with_accept",
    };
  }

  // (5) Hard guard: block any claimType that is neither
  // `accredited_institution` nor `settlement_capacity`. Replace
  // with a priced `propose` so the cross stays visible. Only
  // reached when step 4 didn't fire (gate still blocked).
  if (claimTypeForbiddenInGuarded(llmDecision.claimType)) {
    return {
      decision: {
        action: "propose",
        price: pickGuardedPrice(llmDecision, bounds, bounds.minPrice),
        quantity: pickGuardedQuantity(llmDecision, bounds, bounds.targetQuantity),
        strategicIntent: llmDecision.strategicIntent ?? "open_patiently",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning:
          "Guarded fast-path: unrecognised claim type; restating priced terms instead.",
      },
      overrideReason: "never_emit_settlement_capacity",
    };
  }

  // (6) Counterpart claim gate: the counterpart has priced but at
  // least one required claim is not yet verified. Restate priced
  // terms so the cross stays visible. The counterpart will see our
  // reveals on their turn and reciprocate.
  if (
    !counterpartClaimVerified(ctx.receivedClaims) ||
    !counterpartSecondaryClaimVerified(ctx.receivedClaims)
  ) {
    return {
      decision: {
        action: "propose",
        price: pickGuardedPrice(
          llmDecision,
          bounds,
          counterpartPrice ?? bounds.minPrice,
        ),
        quantity: pickGuardedQuantity(
          llmDecision,
          bounds,
          counterpartQuantity ?? bounds.targetQuantity,
        ),
        strategicIntent: llmDecision.strategicIntent ?? "open_patiently",
        confidence: llmDecision.confidence ?? 0,
        escalationRequested: false,
        settlementReadiness: "not_ready",
        reasoning: `Required claims not yet fully verified; restating priced terms so cross stays visible.`,
      },
      overrideReason: "replaced_with_propose",
    };
  }

  // (7) Fallback (shouldn't normally hit). Keep the LLM's priced
  // proposal so the loop can keep trying.
  return {
    decision: {
      action: "propose",
      price: pickGuardedPrice(llmDecision, bounds, bounds.minPrice),
      quantity: pickGuardedQuantity(llmDecision, bounds, bounds.targetQuantity),
      strategicIntent: llmDecision.strategicIntent ?? "open_patiently",
      confidence: llmDecision.confidence ?? 0,
      escalationRequested: false,
      settlementReadiness: "near",
      reasoning: llmDecision.reasoning,
    },
    overrideReason: "replaced_with_propose",
  };
}
