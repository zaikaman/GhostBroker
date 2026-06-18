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
  | "replaced_with_request_accredited_institution"
  | "replaced_with_propose"
  | "replaced_with_accept"
  | "preserved_llm_decision";

export interface GuardedSelectorResult {
  decision: NegotiationDecision;
  overrideReason: GuardedOverrideReason;
}

/**
 * The single claim the guarded protocol ever asks for or reveals.
 * `settlement_capacity` is intentionally excluded — that fact is
 * pre-cleared by the backend's `assertSettlementReady()` check
 * before the hosted agent ever starts, not negotiated per round.
 */
export const GUARDED_DEMO_CLAIM = "accredited_institution";

/**
 * Return true when the LLM's `claimType` would have asked for (or
 * revealed) a non-demo claim the guarded protocol forbids on the
 * hackathon path. Used to drive the
 * `never_emit_settlement_capacity` override branch.
 */
function claimTypeForbiddenInGuarded(claimType: string | undefined): boolean {
  if (claimType === undefined) return false;
  // The only claim the guarded hackathon path may exchange is
  // `accredited_institution`. Everything else — including
  // `settlement_capacity` — is either pre-cleared or out of scope
  // for the demo.
  return claimType !== GUARDED_DEMO_CLAIM;
}

/**
 * True when THIS side has already revealed `accredited_institution`
 * on a prior round. The selector uses this to decide whether the
 * next move should be a `reveal` or skip ahead to `propose` /
 * `accept`.
 */
function hasRevealedDemoClaim(priorReveals: readonly string[]): boolean {
  return priorReveals.includes(GUARDED_DEMO_CLAIM);
}

/**
 * True when THIS side has already asked the counterpart to prove
 * `accredited_institution` on a prior round. The selector uses this
 * to avoid repeated disclosure loops: after one request, the next
 * move restates priced terms instead of asking again.
 */
function hasRequestedDemoClaim(priorRequests: readonly string[]): boolean {
  return priorRequests.includes(GUARDED_DEMO_CLAIM);
}

/**
 * True when the counterpart has already verified
 * `accredited_institution` for THIS side — i.e. the disclosure gate
 * has cleared for that claim.
 */
function counterpartClaimVerified(
  receivedClaims: readonly string[],
): boolean {
  return receivedClaims.includes(GUARDED_DEMO_CLAIM);
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
 *   1. If the LLM picked a forbidden claimType (anything other than
 *      `accredited_institution`), the move is replaced with a priced
 *      `propose` and the reason is `never_emit_settlement_capacity`.
 *
 *   2. Opening turn (counterpart has no standing terms):
 *      always `propose`, even when the LLM tried to disclose.
 *
 *   3. Counterpart has standing terms but the counterpart's
 *      `accredited_institution` is not yet verified:
 *      a. If THIS side has not yet requested the claim → `request_disclosure`.
 *      b. If THIS side already asked once → priced `propose`
 *         (never loop on disclosure).
 *
 *   4. THIS side has not yet revealed its own
 *      `accredited_institution`: `reveal` with the demo claim.
 *
 *   5. Counterpart terms are visible, the demo claim is verified
 *      both ways: `accept` at counterpart standing price /
 *      quantity.
 *
 *   6. Otherwise: priced `propose` (the LLM's price honoured inside
 *      the band) so the cross stays visible.
 */
export function selectGuardedNegotiationMove(
  input: GuardedSelectorInput,
): GuardedSelectorResult {
  const { bounds, ctx, llmDecision } = input;

  // (1) Hard guard: never emit `settlement_capacity` (or any other
  // non-demo claim) at runtime. Replace with a priced `propose` so
  // the cross stays visible.
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
          "Guarded fast-path: settlement_capacity is pre-cleared before launch; restating priced terms instead.",
      },
      overrideReason: "never_emit_settlement_capacity",
    };
  }

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

  // (2) Opening turn: always `propose`. The LLM still picks the
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

  // (3) Disclosure gate (counterpart side): if the counterpart has
  // priced but has NOT yet verified the demo claim, ask once. Never
  // ask twice — that is what was causing the 10-40 tick loops.
  if (!counterpartClaimVerified(ctx.receivedClaims)) {
    if (!hasRequestedDemoClaim(ctx.priorRequests)) {
      return {
        decision: {
          action: "request_disclosure",
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
          strategicIntent: llmDecision.strategicIntent ?? "request_proof",
          confidence: llmDecision.confidence ?? 0,
          escalationRequested: false,
          settlementReadiness: "not_ready",
          reasoning: `Guarded fast-path: requesting ${GUARDED_DEMO_CLAIM} verification before accepting terms.`,
        },
        overrideReason: "replaced_with_request_accredited_institution",
      };
    }
    // Already asked once — restate priced terms to keep the cross
    // visible instead of looping on disclosure.
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
        reasoning: `Already requested ${GUARDED_DEMO_CLAIM} once; restating priced terms so the cross stays visible.`,
      },
      overrideReason: "replaced_with_propose",
    };
  }

  // (4) Reciprocal gate (our side): if WE have not yet revealed
  // `accredited_institution`, do so now while restating terms.
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

  // (5) Both sides have verified and disclosed. Accept the cross at
  // the counterpart's standing terms — the LLM's price is honoured
  // only if it happens to match.
  if (
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
          "Guarded fast-path: both sides verified; accepting counterpart standing terms.",
      },
      overrideReason: "replaced_with_accept",
    };
  }

  // (6) Fallback (shouldn't normally hit — the orchestrator only
  // sets counterpartStandingPrice once it's a real number, and
  // walkaway is handled above). Keep the LLM's priced proposal
  // so the loop can keep trying.
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