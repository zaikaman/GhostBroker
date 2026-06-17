import Groq from "groq-sdk";
import { z } from "zod";
import {
  validateAgentDecision,
  type AgentDecisionMove,
  type NegotiationTurnContext,
} from "@ghostbroker/negotiation-core";
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

/**
 * Agent-side context. Extends the shared {@link NegotiationTurnContext}
 * with the settlement quote asset code (an LLM-only field the backend
 * never carries). Built via the shared `buildTurnContext` so the
 * bounds are guaranteed to match the orchestrator's authoritative
 * validator.
 */
export interface NegotiationContext extends NegotiationTurnContext {
  quoteAssetCode: string;
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
                quantity must be > 0 and within your mandate. Use this on the FIRST turn
                of a session — without a priced proposal the round evaluator cannot run.
  - "counter":  respond to the counterparty's standing terms with a revised price/quantity
                inside your bounds. Move toward the counterparty only as much as your
                mandate and urgency justify.
  - "reveal":   disclose one verified claim to build trust. Set claimType to one of
                disclosableClaims. price/quantity should restate your current terms.
                The hosted runtime will attach a self-attested credential automatically
                so the disclosure records as verified. Use at most once per claim.
  - "request_disclosure": ask the counterparty to prove a claim listed in requiredClaims.
                Set claimType to the required claim. price/quantity restate current terms.
                Use at most ONCE per claim; after that, put terms on the table.
  - "accept":   accept when the counterparty's standing terms are inside your mandate and
                further rounds are unlikely to improve them. price/quantity must equal the
                terms you are accepting.
  - "hold":     make no concession this round (waiting on a disclosure or testing patience).
                price/quantity restate your current terms.
  - "walkaway": abandon the negotiation when terms cannot reach your mandate before the
                deadline, or a required disclosure was refused. price=0, quantity=0.

OPENING-TURN RULE (read carefully):
  - If counterpart_standing_price is "(none)" (i.e. the counterpart has not yet proposed),
    you MUST return action="propose" with a price inside [minPrice, maxPrice]. The shared
    validator downgrades "reveal" / "request_disclosure" / "hold" on the opening turn to
    "propose" anyway, so emitting a priced proposal yourself saves a round.
  - The disclosure gate (which requires verified claims from both sides) ONLY gates the
    final settlement. You can and SHOULD propose terms before every required claim is
    verified — the cross evaluator runs on price/quantity alone.

TRUST-FIRST SPECIFIC:
  - For execution_style="trust_first", spend at most ONE round on a "reveal" of each
    disclosable claim and ONE round on a "request_disclosure" of each required claim,
    then switch to priced proposals. The validator downgrades further disclosure-only
    moves to "propose" automatically.

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
    faster; "trust_first" spends at most one round on each disclosure move before
    proposing terms.
  - Never cross your own mandate bounds. The enclave will reject out-of-bounds moves.
  - Prefer "accept" over additional rounds once terms are acceptable; rounds are limited.
  - If your approval mode is "escalate_outside_envelope", set escalationRequested=true
    when the move would go outside your preferred envelope.
  - Use "reveal" / "request_disclosure" strategically to build trust, but never at the
    expense of putting a priced proposal on the table.
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
    `opening_turn: ${ctx.counterpartStandingPrice === null ? "yes (no counterpart proposal yet — you MUST propose)" : "no"}`,
    ``,
    `=== DISCLOSURE ===`,
    `trust_level: ${ctx.trustLevel}`,
    `disclosable_claims: ${ctx.disclosableClaims.length > 0 ? ctx.disclosableClaims.join(", ") : "(none)"}`,
    `received_claims: ${ctx.receivedClaims.length > 0 ? ctx.receivedClaims.join(", ") : "(none)"}`,
    `required_claims: ${ctx.requiredClaims.length > 0 ? ctx.requiredClaims.join(", ") : "(none)"}`,
    `prior_claim_requests_this_session: ${
      ctx.priorClaimRequests && ctx.priorClaimRequests.length > 0
        ? ctx.priorClaimRequests.join(", ")
        : "(none — this is your first disclosure-related move)"
    }`,
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
// Helpers — the shared validator is the single source of truth.
// ---------------------------------------------------------------------------

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
// Clamp decision through the shared strategy validator.
// ---------------------------------------------------------------------------

/**
 * Validate an LLM-proposed move through the shared
 * {@link validateAgentDecision} validator. The validator is the same
 * code the backend orchestrator runs as its authoritative bound; the
 * agent pre-clamps here to keep its outputs honest and avoid burning
 * a round on a guaranteed-rejected move.
 */
export function clampNegotiationDecision(
  decision: NegotiationDecision,
  ctx: NegotiationContext,
): NegotiationDecision {
  const move: AgentDecisionMove = {
    action: decision.action,
    ...(decision.price !== undefined ? { price: decision.price } : {}),
    ...(decision.quantity !== undefined ? { quantity: decision.quantity } : {}),
    ...(decision.claimType !== undefined ? { claimType: decision.claimType } : {}),
    ...(decision.strategicIntent !== undefined
      ? { strategicIntent: decision.strategicIntent }
      : {}),
    ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
    ...(decision.escalationRequested !== undefined
      ? { escalationRequested: decision.escalationRequested }
      : {}),
    ...(decision.settlementReadiness !== undefined
      ? { settlementReadiness: decision.settlementReadiness }
      : {}),
    reasoning: decision.reasoning,
  };
  const validated = validateAgentDecision(move, ctx).accepted;
  return {
    action: validated.action,
    price: validated.price ?? 0,
    quantity: validated.quantity ?? 0,
    ...(validated.claimType !== undefined ? { claimType: validated.claimType } : {}),
    strategicIntent: validated.strategicIntent ?? defaultIntentFor(validated.action),
    confidence: validated.confidence ?? 0,
    escalationRequested: validated.escalationRequested,
    settlementReadiness: validated.settlementReadiness ?? "not_ready",
    reasoning: validated.reasoning,
  };
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
