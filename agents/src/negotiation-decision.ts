import Groq from "groq-sdk";
import { z } from "zod";
import { extractJsonObject } from "./llm-decision.js";

// ---------------------------------------------------------------------------
// Decision schema (mirrors the backend's expanded move contract)
// ---------------------------------------------------------------------------

export const negotiationDecisionSchema = z.object({
  action: z.enum([
    "propose",
    "counter",
    "reveal",
    "request_disclosure",
    "accept",
    "hold",
    "walkaway",
  ]),
  price: z.number().nonnegative(),
  quantity: z.number().nonnegative(),
  claimType: z.string().trim().max(64).optional(),
  /** LLM-declared strategic intent for this move. */
  strategicIntent: z
    .enum([
      "open_patiently",
      "test_patience",
      "concede",
      "hold_for_better_terms",
      "build_trust",
      "request_proof",
      "accelerate_for_deadline",
      "accept",
      "walkaway",
    ])
    .optional(),
  /** Confidence 0..1 the LLM declares for this move. */
  confidence: z.number().min(0).max(1).optional(),
  /** Whether the LLM is asking the operator to escalate. */
  escalationRequested: z.boolean().optional(),
  /** LLM's settlement readiness assessment. */
  settlementReadiness: z
    .enum(["not_ready", "near", "ready"])
    .optional(),
  reasoning: z.string().max(4000),
});

export type NegotiationDecision = z.infer<typeof negotiationDecisionSchema>;

// ---------------------------------------------------------------------------
// Negotiation context — everything the agent is allowed to see
// ---------------------------------------------------------------------------

export interface NegotiationContext {
  side: "buy" | "sell";
  assetCode: string;
  quoteAssetCode: string;

  // --- Authored policy surface ---
  objective: string;
  executionStyle:
    | "patient"
    | "balanced"
    | "aggressive"
    | "relationship_first"
    | "trust_first";
  urgency: "low" | "normal" | "high" | "critical";

  // --- Size ---
  targetQuantity: number;
  minimumQuantity: number;
  partialExecutionAllowed: boolean;

  // --- Derived bounds ---
  referencePrice: number;
  minPrice: number;
  maxPrice: number;
  maxNotional: number;

  // --- Concession ---
  concessionBudgetRemainingBps: number;

  // --- Session signals ---
  roundNumber: number;
  maxRounds: number;
  roundsRemaining: number;
  deadline: string;
  timeToDeadlineMs: number;
  distanceSignal: "crossed" | "near" | "moderate" | "far" | null;
  counterpartPattern: "unknown" | "cooperative" | "resistant";
  counterpartStandingPrice: number | null;
  counterpartStandingQuantity: number | null;

  // --- Disclosure ---
  disclosableClaims: string[];
  receivedClaims: string[];
  requiredClaims: string[];
  trustLevel: "none" | "partial" | "established";

  // --- Approval ---
  approvalMode: "auto_settle" | "escalate_outside_envelope";

  // --- Operator guidance ---
  operatorInstructions: string;
  lastOutcome?: string;
  priorMoveRationale?: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a hosted GhostBroker institutional negotiation agent.
You operate inside GhostBroker-managed confidential infrastructure.
You cannot see the counterparty's identity, mandate, private limit price, or queue.
You may only use the information provided for the current round.

You negotiate a single confidential block trade on behalf of your institution.
Each round you choose exactly one action and return strict JSON only.
Do not output prose, markdown, or code fences.

ACTIONS:
  - "propose":  open or restate your terms. price must be inside [minPrice, maxPrice];
                quantity must be > 0 and within your mandate. Use early in a session.
  - "counter":  respond to the counterparty's standing terms with a revised price/quantity
                inside your bounds. Move toward the counterparty only as much as your
                mandate and urgency justify.
  - "reveal":   disclose one verified claim to build trust. Set claimType to one of
                disclosableClaims. price/quantity should restate your current terms.
  - "request_disclosure": ask the counterparty to prove a claim listed in requiredClaims.
                Set claimType to the required claim. price/quantity restate current terms.
  - "accept":   accept when the counterparty's standing terms are inside your mandate and
                further rounds are unlikely to improve them. price/quantity must equal the
                terms you are accepting.
  - "hold":     make no concession this round (waiting on a disclosure or testing patience).
                price/quantity restate your current terms.
  - "walkaway": abandon the negotiation when terms cannot reach your mandate before the
                deadline, or a required disclosure was refused. price=0, quantity=0.

NEW FIELDS (include in every response):
  - "strategicIntent": explain WHY you chose this move. One of:
    "open_patiently", "test_patience", "concede", "hold_for_better_terms",
    "build_trust", "request_proof", "accelerate_for_deadline", "accept", "walkaway".
  - "confidence": a number 0.0 to 1.0 indicating how confident you are this move
    advances your objective.
  - "escalationRequested": true only if this move requires operator approval per your
    approval policy (e.g. when terms are outside the preferred envelope).
  - "settlementReadiness": "not_ready", "near", or "ready" — how close you think the
    sides are to a deal.

GUIDANCE:
  - Respect urgency: "critical" should converge faster and concede more; "low" can hold.
  - Respect your executionStyle: "patient" moves in small steps; "aggressive" concedes
    faster; "trust_first" prioritizes disclosure over price moves.
  - Never cross your own mandate bounds. The enclave will reject out-of-bounds moves.
  - Prefer "accept" over additional rounds once terms are acceptable; rounds are limited.
  - If your approval mode is "escalate_outside_envelope", set escalationRequested=true
    when the move would go outside your preferred envelope.
  - Use "reveal" / "request_disclosure" strategically to build trust and satisfy
    counterparty requirements.
  - Consider roundsRemaining and timeToDeadlineMs — don't hold too long near the deadline.

Output exactly:
{
  "action": "propose" | "counter" | "reveal" | "request_disclosure" | "accept" | "hold" | "walkaway",
  "price": <number>,
  "quantity": <number>,
  "claimType": "<optional claim type>",
  "strategicIntent": "<strategic intent>",
  "confidence": <0.0 to 1.0>,
  "escalationRequested": true | false,
  "settlementReadiness": "not_ready" | "near" | "ready",
  "reasoning": "<= 4000 chars, plain text>"
}`;

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function negotiationUserPrompt(ctx: NegotiationContext): string {
  const lines: string[] = [
    `=== SESSION STATE ===`,
    `round: ${ctx.roundNumber}/${ctx.maxRounds} (${ctx.roundsRemaining} remaining)`,
    `side: ${ctx.side}`,
    `asset_code: ${ctx.assetCode}`,
    `quote_asset_code: ${ctx.quoteAssetCode}`,
    ``,
    `=== MANDATE ===`,
    `objective: ${ctx.objective}`,
    `execution_style: ${ctx.executionStyle}`,
    `urgency: ${ctx.urgency}`,
    `target_quantity: ${ctx.targetQuantity}`,
    `minimum_quantity: ${ctx.minimumQuantity}`,
    `partial_execution_allowed: ${ctx.partialExecutionAllowed}`,
    `reference_price: ${ctx.referencePrice}`,
    `min_price: ${ctx.minPrice}`,
    `max_price: ${ctx.maxPrice}`,
    `max_notional: ${ctx.maxNotional}`,
    `concession_budget_remaining_bps: ${ctx.concessionBudgetRemainingBps}`,
    `approval_mode: ${ctx.approvalMode}`,
    `deadline: ${ctx.deadline}`,
    `time_to_deadline_ms: ${ctx.timeToDeadlineMs}`,
    ``,
    `=== COUNTERPARTY SIGNALS ===`,
    `distance_signal: ${ctx.distanceSignal ?? "(unknown)"}`,
    `counterpart_pattern: ${ctx.counterpartPattern}`,
    `counterpart_standing_price: ${ctx.counterpartStandingPrice ?? "(none)"}`,
    `counterpart_standing_quantity: ${ctx.counterpartStandingQuantity ?? "(none)"}`,
    ``,
    `=== DISCLOSURE ===`,
    `trust_level: ${ctx.trustLevel}`,
    `disclosable_claims: ${ctx.disclosableClaims.length > 0 ? ctx.disclosableClaims.join(", ") : "(none)"}`,
    `received_claims: ${ctx.receivedClaims.length > 0 ? ctx.receivedClaims.join(", ") : "(none)"}`,
    `required_claims: ${ctx.requiredClaims.length > 0 ? ctx.requiredClaims.join(", ") : "(none)"}`,
    ``,
    `=== HISTORY ===`,
    `last_round_outcome: ${ctx.lastOutcome ?? "(none)"}`,
    `prior_move_rationale: ${ctx.priorMoveRationale ?? "(none)"}`,
    ``,
    `=== OPERATOR INSTRUCTIONS ===`,
    ctx.operatorInstructions ? `${ctx.operatorInstructions}` : "(none)",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function roundQty(quantity: number): number {
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

function clampConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
}

function defaultIntentFor(
  action: NegotiationDecision["action"],
): NegotiationDecision["strategicIntent"] {
  switch (action) {
    case "propose":
      return "open_patiently";
    case "counter":
      return "concede";
    case "accept":
      return "accept";
    case "hold":
      return "hold_for_better_terms";
    case "reveal":
      return "build_trust";
    case "request_disclosure":
      return "request_proof";
    case "walkaway":
      return "walkaway";
    default:
      return "test_patience";
  }
}

// ---------------------------------------------------------------------------
// Clamp decision within mandate bounds
// ---------------------------------------------------------------------------

/**
 * Clamp an LLM-proposed move into the agent's mandate bounds and fill
 * in default strategic metadata. The enclave is the authority and will
 * reject anything out of bounds, but clamping here keeps the agent
 * honest and avoids burning a round on a guaranteed-rejected move.
 */
export function clampNegotiationDecision(
  decision: NegotiationDecision,
  ctx: NegotiationContext,
): NegotiationDecision {
  const { action, reasoning } = decision;

  // Shared metadata: fill defaults for optional strategic fields.
  const strategicIntent =
    decision.strategicIntent ?? defaultIntentFor(action);
  const confidence = clampConfidence(decision.confidence);
  const escalationRequested = Boolean(decision.escalationRequested);
  const settlementReadiness =
    decision.settlementReadiness ?? settlementReadinessFor(ctx);

  if (action === "walkaway") {
    return {
      action,
      price: 0,
      quantity: 0,
      strategicIntent,
      confidence,
      escalationRequested,
      settlementReadiness: "not_ready",
      reasoning,
    };
  }

  // Disclosure moves must reference an allowed claim.
  if (action === "reveal") {
    const claimType =
      decision.claimType && ctx.disclosableClaims.includes(decision.claimType)
        ? decision.claimType
        : ctx.disclosableClaims[0];
    if (!claimType) {
      return {
        action: "hold",
        price: roundPrice(clampPrice(decision.price, ctx)),
        quantity: roundQty(clampQuantity(decision.quantity, ctx)),
        strategicIntent: "hold_for_better_terms",
        confidence,
        escalationRequested,
        settlementReadiness: "not_ready",
        reasoning: "No disclosable claim available; holding instead.".slice(
          0,
          280,
        ),
      };
    }
    return {
      action: "reveal",
      price: roundPrice(clampPrice(decision.price, ctx)),
      quantity: roundQty(clampQuantity(decision.quantity, ctx)),
      claimType,
      strategicIntent,
      confidence,
      escalationRequested,
      settlementReadiness,
      reasoning,
    };
  }

  if (action === "request_disclosure") {
    const claimType =
      decision.claimType && ctx.requiredClaims.includes(decision.claimType)
        ? decision.claimType
        : ctx.requiredClaims[0];
    if (!claimType) {
      return {
        action: "hold",
        price: roundPrice(clampPrice(decision.price, ctx)),
        quantity: roundQty(clampQuantity(decision.quantity, ctx)),
        strategicIntent: "hold_for_better_terms",
        confidence,
        escalationRequested,
        settlementReadiness: "not_ready",
        reasoning:
          "No outstanding required claim to request; holding instead.".slice(
            0,
            280,
          ),
      };
    }
    return {
      action: "request_disclosure",
      price: roundPrice(clampPrice(decision.price, ctx)),
      quantity: roundQty(clampQuantity(decision.quantity, ctx)),
      claimType,
      strategicIntent,
      confidence,
      escalationRequested,
      settlementReadiness,
      reasoning,
    };
  }

  // propose | counter | accept — carry price/quantity bounded by rails.
  const price = clampPrice(decision.price, ctx);
  const quantity = clampQuantity(decision.quantity, ctx);

  // Enforce the per-trade notional ceiling.
  let finalQuantity = quantity;
  if (price > 0 && price * finalQuantity > ctx.maxNotional) {
    finalQuantity = ctx.maxNotional / price;
  }

  // Full-block-only: if partial not allowed, force target quantity.
  if (!ctx.partialExecutionAllowed && finalQuantity < ctx.targetQuantity) {
    finalQuantity = ctx.targetQuantity;
  }

  return {
    action,
    price: roundPrice(price),
    quantity: roundQty(finalQuantity),
    strategicIntent,
    confidence,
    escalationRequested,
    settlementReadiness,
    reasoning,
  };
}

function clampPrice(
  price: number | undefined,
  ctx: NegotiationContext,
): number {
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return ctx.referencePrice;
  }
  return Math.max(ctx.minPrice, Math.min(ctx.maxPrice, price));
}

function clampQuantity(
  quantity: number | undefined,
  ctx: NegotiationContext,
): number {
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
    return ctx.targetQuantity;
  }
  return Math.min(quantity, ctx.targetQuantity);
}

function settlementReadinessFor(
  ctx: NegotiationContext,
): "not_ready" | "near" | "ready" {
  if (ctx.distanceSignal === "crossed") return "ready";
  if (ctx.distanceSignal === "near") return "near";
  return "not_ready";
}

// ---------------------------------------------------------------------------
// LLM client interface & Groq implementation
// ---------------------------------------------------------------------------

export interface NegotiationLlmClient {
  decide(ctx: NegotiationContext): Promise<NegotiationDecision>;
}

export class GroqNegotiationClient implements NegotiationLlmClient {
  private readonly client: Groq;
  private readonly model: string;
  private readonly temperature: number;

  public constructor(options: {
    apiKey: string;
    model: string;
    temperature?: number;
  }) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error("GroqNegotiationClient requires a non-empty apiKey");
    }
    this.client = new Groq({ apiKey: options.apiKey });
    this.model = options.model;
    this.temperature = options.temperature ?? 0.5;
  }

  public async decide(ctx: NegotiationContext): Promise<NegotiationDecision> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      top_p: 0.95,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: negotiationUserPrompt(ctx) },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    if (raw.length === 0) {
      throw new Error("Groq returned an empty negotiation completion");
    }
    const parsed = extractJsonObject(raw);
    const validated = negotiationDecisionSchema.parse(parsed);
    return clampNegotiationDecision(validated, ctx);
  }
}
