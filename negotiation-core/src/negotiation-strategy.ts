/**
 * Negotiation strategy normalization — the single source of truth.
 *
 * This package owns the AI-first split between what an operator
 * *authors* (intent, constraints, trust requirements, urgency,
 * approval boundaries) and what the system *derives* for execution
 * (reservation bounds, concession envelope, valuation anchor,
 * notional ceiling). Both the backend orchestrator and the hosted
 * agent runtime import this module so derived rails, turn context,
 * and move validation are guaranteed to be identical.
 *
 * Flow:
 *   operator mandate -> {@link normalizeStrategy} -> derived rails
 *   derived rails     -> {@link buildTurnContext}    -> LLM context
 *   LLM output        -> {@link validateAgentDecision} -> accepted move
 *
 * The derived rails are persisted alongside the authored policy so the
 * enclave/contract can still enforce hard bounds deterministically; the
 * LLM is responsible for strategy, concession pacing, disclosure
 * choices, and deal construction *within* those bounds.
 */

/**
 * The valuation source the operator selects. The operator never types
 * a live quote in the primary flow; they pick how the anchor should be
 * established.
 */
export type ValuationPolicySource =
  | "auto_anchor"
  | "internal_fair_value"
  | "operator_note";

export interface AuthoredValuationPolicy {
  source: ValuationPolicySource;
  /**
   * For `operator_note` / `internal_fair_value`: the operator-supplied
   * reference value the agent should anchor on (USD per unit). For
   * `auto_anchor` this is null/undefined and the runtime is expected
   * to resolve a market oracle value before the first turn.
   */
  anchorValue?: number | null;
  /** Free-text note that rides along for the LLM, never a hard number. */
  note?: string;
}

export interface AuthoredConcessionPolicy {
  /**
   * How quickly the agent may move from its opening stance, in
   * fractions of the total concession budget per round.
   *   patient     ~ small steps, late concession
   *   balanced    ~ steady
   *   aggressive  ~ front-loaded concession
   */
  pace: "patient" | "balanced" | "aggressive";
  /** Max total concession budget expressed in basis points of the anchor. */
  maxConcessionBps: number;
}

export interface AuthoredDisclosurePolicy {
  /** Claim types the agent MAY reveal, in the suggested reveal order. */
  allowLadder: string[];
  /** Claim types that must only be revealed after reciprocal seriousness. */
  requireReciprocityFor?: string[];
}

export type ApprovalMode = "auto_settle" | "escalate_outside_envelope";

export interface AuthoredApprovalPolicy {
  mode: ApprovalMode;
  /** Free-text description of the preferred outcome envelope (not a number). */
  preferredEnvelopeNote?: string;
}

export interface AuthoredSizePolicy {
  targetQuantity: number;
  minimumQuantity: number;
  partialExecutionAllowed: boolean;
}

export interface AuthoredTimeWindow {
  deadline: string;
  /** Optional preferred active window (ISO range); informational for tempo. */
  preferredWindowStart?: string;
  preferredWindowEnd?: string;
}

export interface AuthoredCounterpartyRequirements {
  /** Claim types the counterparty must prove before convergence. */
  requiredClaims: string[];
  /** Disallowed counterparty traits/classes. */
  disallowedTraits: string[];
  /** Minimum reputation / accreditation tier, free-text. */
  reputationTier?: string;
}

/**
 * The full authored policy mandate. This is the operator-facing
 * business-intent object. Numeric execution rails are NOT authored
 * here — they are derived.
 */
export interface AuthoredMandatePolicy {
  objective: string;
  assetCode: string;
  side: "buy" | "sell";
  sizePolicy: AuthoredSizePolicy;
  urgency: "low" | "normal" | "high" | "critical";
  executionStyle:
    | "patient"
    | "balanced"
    | "aggressive"
    | "relationship_first"
    | "trust_first";
  valuationPolicy: AuthoredValuationPolicy;
  concessionPolicy: AuthoredConcessionPolicy;
  disclosurePolicy: AuthoredDisclosurePolicy;
  counterpartyRequirements: AuthoredCounterpartyRequirements;
  approvalPolicy: AuthoredApprovalPolicy;
  timeWindow: AuthoredTimeWindow;
  operatorInstructions: string;
}

/**
 * Derived execution rails. These are the deterministic bounds the
 * enclave/contract and the orchestrator enforce. They are computed
 * once from the authored policy and persisted.
 */
export interface DerivedExecutionRails {
  /** The valuation anchor (USD/unit) the agent reasons from. */
  anchorValue: number;
  /** The price band in basis points around the anchor. */
  priceBandBps: number;
  /** The derived reference price (= anchor). */
  referencePrice: number;
  /** Walk-away lower bound (USD/unit). */
  walkawayMin: number;
  /** Walk-away upper bound (USD/unit). */
  walkawayMax: number;
  /** Max total concession budget in bps of the anchor. */
  concessionBudgetBps: number;
  /** Target quantity (units). */
  targetQuantity: number;
  /** Minimum acceptable quantity (units). */
  minimumQuantity: number;
  /** Whether partial fills are allowed. */
  partialExecutionAllowed: boolean;
  /** Max notional ceiling (USD). */
  notionalCeiling: number;
}

/**
 * The complete normalized strategy profile: authored policy + derived
 * rails. This is what gets persisted and fed to the turn builder.
 */
export interface NegotiationStrategyProfile {
  authored: AuthoredMandatePolicy;
  rails: DerivedExecutionRails;
}

/**
 * Execution-style → concession pace + band multipliers. The band a
 * mandate gets is derived from its style and urgency so the operator
 * never types a basis-points number in the primary flow.
 */
const STYLE_DERIVATION: Record<
  AuthoredMandatePolicy["executionStyle"],
  { paceMultiplier: number; bandMultiplier: number; urgencyLean: number }
> = {
  // patient: tight band, slow concession, holds for better terms
  patient: { paceMultiplier: 0.5, bandMultiplier: 0.6, urgencyLean: -0.2 },
  balanced: { paceMultiplier: 1.0, bandMultiplier: 1.0, urgencyLean: 0.0 },
  // aggressive: wide band, fast concession
  aggressive: { paceMultiplier: 1.8, bandMultiplier: 1.6, urgencyLean: 0.3 },
  // relationship-first: tighter band, values repeat counterparty trust
  relationship_first: { paceMultiplier: 0.7, bandMultiplier: 0.7, urgencyLean: -0.1 },
  // trust-first: tight band until disclosure/trust established
  trust_first: { paceMultiplier: 0.6, bandMultiplier: 0.5, urgencyLean: -0.15 },
};

const URGENCY_LEAN: Record<AuthoredMandatePolicy["urgency"], number> = {
  low: -0.3,
  normal: 0.0,
  high: 0.3,
  // critical: converge fast, concede more, wider acceptable band
  critical: 0.6,
};

/** Base band in bps applied before style/urgency multipliers. */
const BASE_BAND_BPS = 150;

/**
 * The multiplier that shrinks the full walk-away band into the
 * "preferred" operator envelope used by the escalation policy. The
 * preferred envelope is the core of the deal the operator is willing
 * to auto-settle; excursions beyond it escalate.
 */
const PREFERRED_ENVELOPE_SHRINK = 0.5;

export function roundPrice(price: number): number {
  if (!Number.isFinite(price)) return 0;
  return Math.round(price * 100) / 100;
}

export function roundQty(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

/**
 * Resolve the valuation anchor from the authored valuation policy.
 * For `auto_anchor` with no resolved oracle value, falls back to the
 * operator note anchor if present, else throws — the caller (UI /
 * hosted runtime) is responsible for supplying an oracle value for
 * auto_anchor in production.
 */
export function resolveAnchorValue(
  policy: AuthoredValuationPolicy,
): number {
  if (
    policy.anchorValue !== null &&
    policy.anchorValue !== undefined &&
    Number.isFinite(policy.anchorValue) &&
    policy.anchorValue > 0
  ) {
    return policy.anchorValue;
  }
  if (policy.source === "auto_anchor") {
    throw new Error(
      "auto_anchor valuation policy requires a resolved anchor value; supply one before normalizing.",
    );
  }
  throw new Error(
    `Valuation policy '${policy.source}' is missing an anchor value.`,
  );
}

/**
 * Derive the execution rails from an authored policy. Deterministic
 * and side-effect free; the same authored policy always yields the
 * same rails.
 */
export function deriveExecutionRails(
  authored: AuthoredMandatePolicy,
): DerivedExecutionRails {
  const anchorValue = resolveAnchorValue(authored.valuationPolicy);

  const style = STYLE_DERIVATION[authored.executionStyle];
  const urgencyLean = URGENCY_LEAN[authored.urgency];
  const lean = Math.max(0, style.urgencyLean + urgencyLean);

  const bandMultiplier = Math.max(
    0.2,
    style.bandMultiplier * (1 + lean * 0.6),
  );
  const priceBandBps = Math.round(BASE_BAND_BPS * bandMultiplier);

  const concessionBudgetBps = Math.round(
    Math.max(authored.concessionPolicy.maxConcessionBps, priceBandBps) *
      style.paceMultiplier *
      (1 + urgencyLean * 0.4),
  );

  const band = anchorValue * (priceBandBps / 10_000);
  // Buyers may bid up to anchor*(1+bps); sellers may ask down to
  // anchor*(1-bps). The opposite edge is anchored at the reference.
  const walkawayMin = roundPrice(anchorValue - band);
  const walkawayMax = roundPrice(anchorValue + band);

  const notionalCeiling = roundPrice(
    anchorValue * authored.sizePolicy.targetQuantity,
  );

  return {
    anchorValue: roundPrice(anchorValue),
    priceBandBps,
    referencePrice: roundPrice(anchorValue),
    walkawayMin,
    walkawayMax,
    concessionBudgetBps,
    targetQuantity: roundQty(authored.sizePolicy.targetQuantity),
    minimumQuantity: roundQty(authored.sizePolicy.minimumQuantity),
    partialExecutionAllowed: authored.sizePolicy.partialExecutionAllowed,
    notionalCeiling,
  };
}

/**
 * Normalize an authored policy into a full strategy profile (authored
 * + derived rails). This is the single entry point the mandate
 * service uses when persisting a new mandate.
 */
export function normalizeStrategy(
  authored: AuthoredMandatePolicy,
): NegotiationStrategyProfile {
  const rails = deriveExecutionRails(authored);
  return { authored, rails };
}

/**
 * Compute the price band the orchestrator should enforce for a side.
 * Mirrors the legacy `mandatePriceBand` semantics but sourced from
 * derived rails.
 */
export function derivedPriceBandFor(
  rails: DerivedExecutionRails,
  side: "buy" | "sell",
): { minPrice: number; maxPrice: number } {
  // A buyer is willing to pay up to walkawayMax; it will not bid below
  // the anchor. A seller will accept down to walkawayMin; it will not
  // ask above the anchor. The crossing logic happens in the enclave.
  if (side === "buy") {
    return { minPrice: rails.referencePrice, maxPrice: rails.walkawayMax };
  }
  return { minPrice: rails.walkawayMin, maxPrice: rails.referencePrice };
}

/**
 * The narrower envelope the operator is willing to auto-settle within.
 * Settlements outside this envelope must escalate per the approval
 * policy. The envelope is derived from the execution style so the
 * operator never types a number.
 */
export interface PreferredEnvelope {
  minPrice: number;
  maxPrice: number;
}

/**
 * Derive the preferred (auto-settle) envelope for one side of a
 * profile. The envelope is the half-shrunk walkaway band centered on
 * the anchor — what the operator would call "a fair deal" rather
 * than the absolute walk-away edge.
 */
export function preferredEnvelopeFor(
  profile: NegotiationStrategyProfile,
  side: "buy" | "sell",
): PreferredEnvelope {
  const { anchorValue, walkawayMin, walkawayMax } = profile.rails;
  const radius = ((walkawayMax - walkawayMin) / 2) * PREFERRED_ENVELOPE_SHRINK;
  if (side === "buy") {
    return {
      minPrice: roundPrice(anchorValue),
      maxPrice: roundPrice(anchorValue + radius),
    };
  }
  return {
    minPrice: roundPrice(anchorValue - radius),
    maxPrice: roundPrice(anchorValue),
  };
}

/**
 * True when the priced execution sits inside the preferred envelope
 * for the given side. Used by the orchestrator to make escalation a
 * real policy guarantee instead of an LLM self-declaration.
 */
export function priceInsidePreferredEnvelope(
  profile: NegotiationStrategyProfile,
  side: "buy" | "sell",
  executionPrice: number,
): boolean {
  const env = preferredEnvelopeFor(profile, side);
  return executionPrice >= env.minPrice && executionPrice <= env.maxPrice;
}

// ---------------------------------------------------------------------------
// Turn context (what the LLM is allowed to see on its turn)
// ---------------------------------------------------------------------------

export type TrustLevel = "none" | "partial" | "established";

export interface NegotiationTurnContext {
  side: "buy" | "sell";
  assetCode: string;
  objective: string;
  executionStyle: AuthoredMandatePolicy["executionStyle"];
  urgency: AuthoredMandatePolicy["urgency"];
  /** Derived bounds — the LLM reasons within these. */
  referencePrice: number;
  minPrice: number;
  maxPrice: number;
  targetQuantity: number;
  minimumQuantity: number;
  partialExecutionAllowed: boolean;
  maxNotional: number;
  /** Concession budget remaining, in bps of the anchor. */
  concessionBudgetRemainingBps: number;
  /** Disclosure ladder status. */
  disclosableClaims: string[];
  receivedClaims: string[];
  requiredClaims: string[];
  /** Trust / disclosure confidence state (opaque label). */
  trustLevel: TrustLevel;
  /** Session tempo. */
  roundNumber: number;
  maxRounds: number;
  roundsRemaining: number;
  deadline: string;
  timeToDeadlineMs: number;
  /** Counterpart behavior pattern (opaque). */
  counterpartPattern: "unknown" | "cooperative" | "resistant";
  distanceSignal: "crossed" | "near" | "moderate" | "far" | null;
  counterpartStandingPrice: number | null;
  counterpartStandingQuantity: number | null;
  approvalMode: ApprovalMode;
  /** Preferred (auto-settle) envelope bounds — what the operator
   * would call "a fair deal". Excursions beyond this trigger
   * escalation when the approval mode demands it. */
  preferredMinPrice: number;
  preferredMaxPrice: number;
  operatorInstructions: string;
  /**
   * Cumulative list of claim types the actor has already asked the
   * counterpart to verify (or has revealed itself) on prior rounds.
   * Used by the validator to cap repeated disclosure moves so the
   * session doesn't loop on trust-building indefinitely.
   */
  priorClaimRequests?: string[];
  lastOutcome?: string;
  priorMoveRationale?: string;
}

/**
 * Build the LLM turn context from a strategy profile + live session
 * signals. Anything identity-bearing or reservation-threshold-bearing
 * is excluded; only the redacted signals the backend already exposes
 * are carried through.
 */
export function buildTurnContext(input: {
  profile: NegotiationStrategyProfile;
  side: "buy" | "sell";
  roundNumber: number;
  maxRounds: number;
  deadline: string;
  distanceSignal: NegotiationTurnContext["distanceSignal"];
  counterpartStandingPrice: number | null;
  counterpartStandingQuantity: number | null;
  receivedClaims: string[];
  concessionConsumedBps: number;
  counterpartPattern?: NegotiationTurnContext["counterpartPattern"];
  operatorInstructions?: string;
  /** Cumulative list of claim types the actor has already requested or
   * revealed on prior rounds. Used by the validator to cap repeated
   * disclosure moves. If omitted, the validator assumes an empty
   * history (the agent's very first turn). */
  priorClaimRequests?: string[];
  lastOutcome?: string;
  priorMoveRationale?: string;
  /** Optional: trust level computed upstream from a mandate-sourced
   * required-claims set. If omitted, we fall back to receivedClaims
   * membership over the profile's authored required claims, which
   * is the correct semantics anyway. */
  trustLevel?: TrustLevel;
}): NegotiationTurnContext {
  const { profile, side } = input;
  const { minPrice, maxPrice } = derivedPriceBandFor(profile.rails, side);
  const requiredClaims = profile.authored.counterpartyRequirements.requiredClaims;
  const trustLevel: TrustLevel =
    input.trustLevel ??
    (requiredClaims.length === 0
      ? "established"
      : requiredClaims.every((claim) => input.receivedClaims.includes(claim))
        ? "established"
        : input.receivedClaims.length === 0
          ? "none"
          : "partial");

  const roundsRemaining = Math.max(0, input.maxRounds - input.roundNumber);
  const concessionBudgetRemainingBps = Math.max(
    0,
    profile.rails.concessionBudgetBps - Math.max(0, input.concessionConsumedBps),
  );

  const preferred = preferredEnvelopeFor(profile, side);

  return {
    side,
    assetCode: profile.authored.assetCode,
    objective: profile.authored.objective,
    executionStyle: profile.authored.executionStyle,
    urgency: profile.authored.urgency,
    referencePrice: profile.rails.referencePrice,
    minPrice,
    maxPrice,
    targetQuantity: profile.rails.targetQuantity,
    minimumQuantity: profile.rails.minimumQuantity,
    partialExecutionAllowed: profile.rails.partialExecutionAllowed,
    maxNotional: profile.rails.notionalCeiling,
    concessionBudgetRemainingBps,
    disclosableClaims: profile.authored.disclosurePolicy.allowLadder,
    receivedClaims: input.receivedClaims,
    requiredClaims,
    trustLevel,
    roundNumber: input.roundNumber,
    maxRounds: input.maxRounds,
    roundsRemaining,
    deadline: input.deadline,
    timeToDeadlineMs: Math.max(0, Date.parse(input.deadline) - Date.now()),
    counterpartPattern: input.counterpartPattern ?? "unknown",
    distanceSignal: input.distanceSignal,
    counterpartStandingPrice: input.counterpartStandingPrice,
    counterpartStandingQuantity: input.counterpartStandingQuantity,
    approvalMode: profile.authored.approvalPolicy.mode,
    preferredMinPrice: preferred.minPrice,
    preferredMaxPrice: preferred.maxPrice,
    operatorInstructions: input.operatorInstructions ?? "",
    ...(input.priorClaimRequests !== undefined
      ? { priorClaimRequests: input.priorClaimRequests }
      : {}),
    ...(input.lastOutcome !== undefined ? { lastOutcome: input.lastOutcome } : {}),
    ...(input.priorMoveRationale !== undefined
      ? { priorMoveRationale: input.priorMoveRationale }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Policy validator — bounds the LLM's move within the derived rails
// ---------------------------------------------------------------------------

export type StrategicIntent =
  | "open_patiently"
  | "test_patience"
  | "concede"
  | "hold_for_better_terms"
  | "build_trust"
  | "request_proof"
  | "accelerate_for_deadline"
  | "accept"
  | "walkaway";

export interface AgentDecisionMove {
  action:
    | "propose"
    | "counter"
    | "reveal"
    | "request_disclosure"
    | "accept"
    | "hold"
    | "walkaway";
  price?: number;
  quantity?: number;
  claimType?: string;
  /** LLM-declared strategic intent for this move. */
  strategicIntent?: StrategicIntent;
  /** Confidence 0..1 the LLM declares for this move. */
  confidence?: number;
  /** Whether the LLM is asking the operator to escalate. */
  escalationRequested?: boolean;
  /** LLM's settlement readiness assessment. */
  settlementReadiness?: "not_ready" | "near" | "ready";
  reasoning: string;
}

export interface DecisionValidationResult {
  accepted: AgentDecisionMove;
  /** Why the validator adjusted the move (clamped), if it did. */
  adjustedReason?: string;
  /** Whether the validator downgraded the action. */
  downgradedFrom?: AgentDecisionMove["action"];
}

/**
 * Deterministic policy validator. Takes an LLM-proposed move and the
 * turn context, returns the bounded move the orchestrator may accept.
 *
 * This is the safety layer that lets the LLM own strategy while the
 * system owns bounds. Out-of-band prices/quantities are clamped (never
 * silently accepted beyond rails); invalid disclosures are downgraded
 * to holds; the concession budget is enforced across moves.
 *
 * Opening-turn enforcement: on a turn where the counterpart has no
 * standing proposal yet, disclosure-only moves (`reveal`,
 * `request_disclosure`) are downgraded to `propose`. The disclosure
 * gate only gates settlement; the first move of a session must put a
 * price on the table so the round evaluator can run.
 *
 * Repeated-disclosure cap: a claim the actor has already asked about
 * once is downgraded on the next attempt — the LLM gets one
 * reciprocity window, after which it must put terms on the table.
 */
export function validateAgentDecision(
  move: AgentDecisionMove,
  ctx: NegotiationTurnContext,
): DecisionValidationResult {
  const { action } = move;

  // ---------------------------------------------------------------------
  // Walkaway is a no-rail terminal action; no opening-turn or repeat-cap
  // adjustment applies.
  // ---------------------------------------------------------------------
  if (action === "walkaway") {
    return {
      accepted: {
        action: "walkaway",
        price: 0,
        quantity: 0,
        strategicIntent: move.strategicIntent ?? "walkaway",
        confidence: clampConfidence(move.confidence),
        escalationRequested: Boolean(move.escalationRequested),
        settlementReadiness: "not_ready",
        reasoning: move.reasoning,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Disclosure moves that have no possible target (no disclosable claim
  // for `reveal`, no outstanding required claim for `request_disclosure`)
  // are downgraded to `hold` BEFORE the opening-turn check. Otherwise
  // the opening-turn rule would convert a "nothing to disclose" reveal
  // into a priced proposal, which is wrong: the LLM may still need to
  // wait for the counterpart to propose first.
  // ---------------------------------------------------------------------
  if (action === "reveal" && ctx.disclosableClaims.length === 0) {
    return {
      accepted: restatedHold(move, ctx, "No disclosable claim available; holding instead."),
      downgradedFrom: "reveal",
      adjustedReason: "no_disclosable_claim",
    };
  }
  if (action === "request_disclosure" && ctx.requiredClaims.length === 0) {
    return {
      accepted: restatedHold(
        move,
        ctx,
        "No outstanding required claim to request; holding instead.",
      ),
      downgradedFrom: "request_disclosure",
      adjustedReason: "no_outstanding_required_claim",
    };
  }

  // ---------------------------------------------------------------------
  // Opening turn: the counterpart has no standing proposal yet. Force
  // a priced move (propose) so the round evaluator can run.
  // `request_disclosure` and `reveal` are downgraded to `propose` here.
  // The LLM still owns price/quantity/strategic intent inside the
  // accepted move; we only adjust the action.
  // ---------------------------------------------------------------------
  const isOpeningTurn = ctx.counterpartStandingPrice === null;
  if (isOpeningTurn && (action === "request_disclosure" || action === "reveal")) {
    return {
      accepted: restatedPropose(
        move,
        ctx,
        "Opening turn requires a priced move; the disclosure gate only gates settlement, not proposal. Putting terms on the table.",
      ),
      downgradedFrom: action,
      adjustedReason: "opening_turn_must_propose",
    };
  }

  // ---------------------------------------------------------------------
  // Repeated disclosure cap: track which claims have been requested in
  // the actor's own history. `priorClaimRequests` is the cumulative set
  // of claim types the actor has already asked the counterpart to prove
  // on previous rounds. Asking a second time without putting terms on
  // the table is downgraded to a `propose`.
  // ---------------------------------------------------------------------
  const priorRequested = ctx.priorClaimRequests ?? [];
  if (action === "request_disclosure" && move.claimType) {
    const repeatedRequestCount = priorRequested.filter(
      (claim) => claim === move.claimType,
    ).length;
    if (repeatedRequestCount >= 1) {
      // Already asked once; switch to proposing terms.
      return {
        accepted: restatedPropose(
          move,
          ctx,
          `Already requested disclosure of '${move.claimType}'; putting terms on the table instead so the cross can be evaluated.`,
        ),
        downgradedFrom: action,
        adjustedReason: "repeated_disclosure_request",
      };
    }
  }
  if (action === "reveal" && move.claimType) {
    const repeatedRevealCount = priorRequested.filter(
      (claim) => claim === move.claimType,
    ).length;
    if (repeatedRevealCount >= 2) {
      // Revealed twice already; switch to proposing terms to keep the
      // session moving.
      return {
        accepted: restatedPropose(
          move,
          ctx,
          `Already revealed '${move.claimType}' more than once; switching to priced proposal to keep the session moving.`,
        ),
        downgradedFrom: action,
        adjustedReason: "repeated_disclosure_reveal",
      };
    }
  }

  // Disclosure moves must reference an allowed claim.
  if (action === "reveal") {
    const allowLadder = ctx.disclosableClaims;
    const claimType =
      move.claimType && allowLadder.includes(move.claimType)
        ? move.claimType
        : allowLadder[0];
    const accepted: AgentDecisionMove = {
      action: "reveal",
      price: roundPrice(clampPrice(move.price, ctx)),
      quantity: roundQty(clampQuantity(move.quantity, ctx)),
      strategicIntent: move.strategicIntent ?? "build_trust",
      confidence: clampConfidence(move.confidence),
      escalationRequested: Boolean(move.escalationRequested),
      settlementReadiness: move.settlementReadiness ?? "not_ready",
      reasoning: move.reasoning,
    };
    if (claimType !== undefined) {
      accepted.claimType = claimType;
    }
    return { accepted };
  }

  if (action === "request_disclosure") {
    const claimType =
      move.claimType && ctx.requiredClaims.includes(move.claimType)
        ? move.claimType
        : ctx.requiredClaims[0];
    const accepted: AgentDecisionMove = {
      action: "request_disclosure",
      price: roundPrice(clampPrice(move.price, ctx)),
      quantity: roundQty(clampQuantity(move.quantity, ctx)),
      strategicIntent: move.strategicIntent ?? "request_proof",
      confidence: clampConfidence(move.confidence),
      escalationRequested: Boolean(move.escalationRequested),
      settlementReadiness: move.settlementReadiness ?? "not_ready",
      reasoning: move.reasoning,
    };
    if (claimType !== undefined) {
      accepted.claimType = claimType;
    }
    return { accepted };
  }

  // propose | counter | accept — carry price/quantity bounded by rails.
  const price = clampPrice(move.price, ctx);
  const quantity = clampQuantity(move.quantity, ctx);
  let finalQuantity = quantity;
  let adjustedReason: string | undefined;

  if (price > 0 && price * finalQuantity > ctx.maxNotional) {
    finalQuantity = ctx.maxNotional / price;
    adjustedReason = "shrunk_to_notional_ceiling";
  }

  if (!ctx.partialExecutionAllowed && finalQuantity < ctx.targetQuantity) {
    // full-block-only: the agent may not split below target
    finalQuantity = ctx.targetQuantity;
    adjustedReason = adjustedReason ?? "forced_full_block";
  }

  // Detect "deal construction" choices: the agent voluntarily sized
  // below target even though partial fills are allowed and a full
  // block would have fit. Surface the intent in the move's
  // strategicIntent when the LLM did not already declare one.
  const strategicIntent =
    move.strategicIntent ??
    defaultIntentFor(action, {
      partialChosen: ctx.partialExecutionAllowed && quantity < ctx.targetQuantity,
      outsidePreferred:
        price > 0 &&
        ctx.approvalMode === "escalate_outside_envelope" &&
        (price < ctx.preferredMinPrice || price > ctx.preferredMaxPrice),
    });

  // Enforce that escalation is set server-side when the priced move
  // exits the preferred envelope under an escalate approval mode,
  // regardless of what the LLM self-declared.
  const outsidePreferred =
    price > 0 &&
    ctx.approvalMode === "escalate_outside_envelope" &&
    (price < ctx.preferredMinPrice || price > ctx.preferredMaxPrice);
  const escalationRequested = outsidePreferred
    ? true
    : Boolean(move.escalationRequested);

  const accepted: AgentDecisionMove = {
    action,
    price: roundPrice(price),
    quantity: roundQty(finalQuantity),
    strategicIntent,
    confidence: clampConfidence(move.confidence),
    escalationRequested,
    settlementReadiness: move.settlementReadiness ?? settlementReadinessFor(ctx, price),
    reasoning: move.reasoning,
  };

  return {
    accepted,
    ...(adjustedReason ? { adjustedReason } : {}),
    ...(outsidePreferred && !move.escalationRequested
      ? { adjustedReason: adjustedReason ?? "envelope_violation_flagged" }
      : {}),
  };
}

function clampPrice(
  price: number | undefined,
  ctx: NegotiationTurnContext,
): number {
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return ctx.referencePrice;
  }
  return Math.max(ctx.minPrice, Math.min(ctx.maxPrice, price));
}

function clampQuantity(
  quantity: number | undefined,
  ctx: NegotiationTurnContext,
): number {
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
    return ctx.targetQuantity;
  }
  return Math.min(quantity, ctx.targetQuantity);
}

function clampConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
}

function settlementReadinessFor(
  ctx: NegotiationTurnContext,
  _price: number,
): "not_ready" | "near" | "ready" {
  if (ctx.distanceSignal === "crossed") return "ready";
  if (ctx.distanceSignal === "near") return "near";
  return "not_ready";
}

function defaultIntentFor(
  action: AgentDecisionMove["action"],
  hints: { partialChosen: boolean; outsidePreferred: boolean } = {
    partialChosen: false,
    outsidePreferred: false,
  },
): StrategicIntent {
  if (hints.outsidePreferred) {
    return "accelerate_for_deadline";
  }
  if (hints.partialChosen && action === "propose") {
    return "build_trust";
  }
  switch (action) {
    case "propose":
      return "open_patiently";
    case "counter":
      return "concede";
    case "accept":
      return "accept";
    case "hold":
      return "hold_for_better_terms";
    default:
      return "test_patience";
  }
}

function restatedHold(
  move: AgentDecisionMove,
  ctx: NegotiationTurnContext,
  reason: string,
): AgentDecisionMove {
  return {
    action: "hold",
    price: roundPrice(clampPrice(move.price, ctx)),
    quantity: roundQty(clampQuantity(move.quantity, ctx)),
    strategicIntent: "hold_for_better_terms",
    confidence: clampConfidence(move.confidence),
    escalationRequested: Boolean(move.escalationRequested),
    settlementReadiness: "not_ready",
    reasoning: reason.slice(0, 280),
  };
}

/**
 * Restate a move as `propose` so the round evaluator has priced
 * inputs to compare against the counterpart's standing proposal.
 * Used to downgrade disclosure-only moves on the opening turn and
 * after repeated disclosure requests. The LLM's price/quantity are
 * honored within the derived band; a missing/zero price falls back
 * to the reference price so the proposed move is in-band.
 */
function restatedPropose(
  move: AgentDecisionMove,
  ctx: NegotiationTurnContext,
  reason: string,
): AgentDecisionMove {
  const proposedPrice = clampPrice(move.price, ctx);
  const proposedQuantity = clampQuantity(move.quantity, ctx);
  return {
    action: "propose",
    price: roundPrice(proposedPrice),
    quantity: roundQty(proposedQuantity),
    strategicIntent: move.strategicIntent ?? "open_patiently",
    confidence: clampConfidence(move.confidence),
    escalationRequested: Boolean(move.escalationRequested),
    settlementReadiness: move.settlementReadiness ?? "not_ready",
    reasoning: reason.slice(0, 280),
  };
}

// ---------------------------------------------------------------------------
// Compatibility: pair two mandates by compatibility class
// ---------------------------------------------------------------------------

export interface PairingCompatibility {
  compatible: boolean;
  reasons: string[];
}

/**
 * Decide whether two authored mandates are compatible for pairing —
 * not just opposite-side/same-asset, but overlapping size regime,
 * time window, claim compatibility, and settlement profile. Replaces
 * the legacy "any opposite side same asset" matchmaker.
 */
export function pairingCompatibility(
  buyer: NegotiationStrategyProfile,
  seller: NegotiationStrategyProfile,
): PairingCompatibility {
  const reasons: string[] = [];

  if (buyer.authored.assetCode !== seller.authored.assetCode) {
    return { compatible: false, reasons: ["asset_mismatch"] };
  }
  if (buyer.authored.side !== "buy" || seller.authored.side !== "sell") {
    return { compatible: false, reasons: ["side_mismatch"] };
  }

  // Size regime: the tradeable quantity is the min of the two targets.
  // They are incompatible only if the smaller target is below the
  // larger side's minimum AND the larger side forbids partial.
  const tradeable = Math.min(
    buyer.rails.targetQuantity,
    seller.rails.targetQuantity,
  );
  if (
    tradeable < buyer.rails.minimumQuantity &&
    !buyer.rails.partialExecutionAllowed
  ) {
    reasons.push("buyer_size_floor_unmet");
  }
  if (
    tradeable < seller.rails.minimumQuantity &&
    !seller.rails.partialExecutionAllowed
  ) {
    reasons.push("seller_size_floor_unmet");
  }

  // Disallowed trait conflicts: if one side disallows a trait the other
  // discloses, they can't pair. (Disclosure ladders are public claim
  // types, not identities.)
  const buyerDisallows = new Set(buyer.authored.counterpartyRequirements.disallowedTraits);
  const sellerDisallows = new Set(seller.authored.counterpartyRequirements.disallowedTraits);
  const sellerMayDisclose = new Set(seller.authored.disclosurePolicy.allowLadder);
  const buyerMayDisclose = new Set(buyer.authored.disclosurePolicy.allowLadder);
  for (const trait of sellerMayDisclose) {
    if (buyerDisallows.has(trait)) reasons.push(`buyer_disallows_${trait}`);
  }
  for (const trait of buyerMayDisclose) {
    if (sellerDisallows.has(trait)) reasons.push(`seller_disallows_${trait}`);
  }

  return { compatible: reasons.length === 0, reasons };
}

/**
 * Decide whether a session may converge given disclosure/trust state.
 * A mandate with required claims may not settle until every required
 * claim has been received and verified from the counterpart.
 */
export function disclosureGateSatisfied(input: {
  requiredClaims: string[];
  receivedVerifiedClaims: string[];
}): boolean {
  if (input.requiredClaims.length === 0) return true;
  return input.requiredClaims.every((claim) =>
    input.receivedVerifiedClaims.includes(claim),
  );
}

/**
 * Derive a redacted, opaque "what changed this round" label for the
 * disclosure timeline. The UI surfaces this verbatim so the operator
 * sees the AI's reasoning for the trust-building move without leaking
 * the underlying claim contents.
 */
export function disclosureRationaleLabel(input: {
  strategicIntent: string | null;
  verificationOutcome: "verified" | "rejected";
  claimType: string;
  counterpartPattern: "unknown" | "cooperative" | "resistant";
}): string {
  const intent = input.strategicIntent ?? "build_trust";
  const verification = input.verificationOutcome === "verified" ? "Verified" : "Pending";
  if (intent === "request_proof") {
    return `${verification} proof requested (${input.claimType})`;
  }
  if (input.counterpartPattern === "resistant" && intent === "build_trust") {
    return `${verification} reciprocal disclosure offered (${input.claimType})`;
  }
  return `${verification} trust-building reveal (${input.claimType})`;
}