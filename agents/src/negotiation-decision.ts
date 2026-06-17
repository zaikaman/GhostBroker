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
  // The LLM sometimes returns explicit `null` for absent optional
  // fields. Strip `null` to `undefined` before validation so the
  // parsed shape stays `T | undefined` (truly optional under
  // `exactOptionalPropertyTypes`) rather than `T | null | undefined`.
  claimType: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().trim().max(64).optional(),
  ),
  /** LLM-declared strategic intent for this move. */
  strategicIntent: z.preprocess(
    (value) => (value === null ? undefined : value),
    z
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
  ),
  /** Confidence 0..1 the LLM declares for this move. */
  confidence: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.number().min(0).max(1).optional(),
  ),
  /** Whether the LLM is asking the operator to escalate. */
  escalationRequested: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional(),
  ),
  /** LLM's settlement readiness assessment. */
  settlementReadiness: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.enum(["not_ready", "near", "ready"]).optional(),
  ),
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

export const SYSTEM_PROMPT = `You are a hosted GhostBroker institutional negotiation agent.
You operate inside GhostBroker-managed confidential infrastructure.
You cannot see the counterparty's identity, mandate, private limit price, or queue.
You may only use the information provided for the current round.

You negotiate a single confidential block trade on behalf of your institution.
Each round you choose exactly one action and return STRICT JSON that matches the
schema below. Do not output prose, markdown, or code fences — your entire
response IS the JSON object (a downstream parser runs JSON.parse on it).

═══════════════════════════════════════════════════════════════════════════════
RESPONSE SCHEMA (JSON Schema 2020-12 — your response MUST match this)
═══════════════════════════════════════════════════════════════════════════════

{
  "type": "object",
  "required": ["action", "price", "quantity", "reasoning"],
  "additionalProperties": false,
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "propose",
        "counter",
        "reveal",
        "request_disclosure",
        "accept",
        "hold",
        "walkaway"
      ],
      "description": "Exactly one action per round."
    },
    "price": {
      "type": "number",
      "minimum": 0,
      "description": "USD per unit. Must be inside [minPrice, maxPrice] for your side. Use 0 only for walkaway."
    },
    "quantity": {
      "type": "number",
      "minimum": 0,
      "description": "Units of asset_code. Must be inside your [minimumQuantity, targetQuantity] window. Use 0 only for walkaway."
    },
    "claimType": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64,
      "description": "REQUIRED for reveal / request_disclosure. OMIT the key entirely for all other actions — do not emit null or empty string."
    },
    "strategicIntent": {
      "type": "string",
      "enum": [
        "open_patiently",
        "test_patience",
        "concede",
        "hold_for_better_terms",
        "build_trust",
        "request_proof",
        "accelerate_for_deadline",
        "accept",
        "walkaway"
      ]
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "0.0–1.0 confidence that this move advances your objective."
    },
    "escalationRequested": {
      "type": "boolean",
      "description": "true only if this move requires operator approval under your approval policy."
    },
    "settlementReadiness": {
      "type": "string",
      "enum": ["not_ready", "near", "ready"],
      "description": "How close you think the sides are to a deal."
    },
    "reasoning": {
      "type": "string",
      "maxLength": 4000,
      "description": "Plain-text rationale (max 4000 chars). This is the ONLY free-form field."
    }
  }
}

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 1 — opening turn, BUY side, no counterpart proposal yet
(counterpart_standing_price: "(none)", min_price: 10000, max_price: 10075,
target_quantity: 0.0001, execution_style: "trust_first")
═══════════════════════════════════════════════════════════════════════════════

{
  "action": "propose",
  "price": 10002,
  "quantity": 0.0001,
  "strategicIntent": "open_patiently",
  "confidence": 0.85,
  "escalationRequested": false,
  "settlementReadiness": "not_ready",
  "reasoning": "Opening bid inside my walkaway band (10000–10075). Counterpart has not proposed yet, so I MUST put a priced move on the table for the round evaluator to run."
}

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 2 — mid-game counter, BUY side, counterpart is at 9995
(counterpart_standing_price: 9995, preferred envelope: 10000–10037)
═══════════════════════════════════════════════════════════════════════════════

{
  "action": "counter",
  "price": 9998,
  "quantity": 0.0001,
  "strategicIntent": "concede",
  "confidence": 0.7,
  "escalationRequested": false,
  "settlementReadiness": "near",
  "reasoning": "Counterpart is below my walkaway max (10075). I meet at 9998 — still inside my preferred envelope (10000–10037 is the lower half; 9998 is a one-bps overshoot to close the cross). One more round and I will accept."
}

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 3 — trust-first disclosure, SELL side, on the opening turn
(counterpart_standing_price: 10002, requiredClaims: ["accredited_institution"])
═══════════════════════════════════════════════════════════════════════════════

{
  "action": "request_disclosure",
  "price": 10000,
  "quantity": 0.0001,
  "claimType": "accredited_institution",
  "strategicIntent": "request_proof",
  "confidence": 0.6,
  "escalationRequested": false,
  "settlementReadiness": "not_ready",
  "reasoning": "Execution style 'trust_first' requires verifying counterparty's accredited_institution status before progressing terms. One disclosure request, then back to priced proposals. Counterpart is at 10002; my walkaway ceiling is 10000, so I restate 10000 to flag the spread."
}

═══════════════════════════════════════════════════════════════════════════════
ACTIONS (semantic guidance for each action value)
═══════════════════════════════════════════════════════════════════════════════

propose             Open or restate your terms. price inside [minPrice, maxPrice];
                    quantity inside [minimumQuantity, targetQuantity]. Use on the
                    FIRST turn of a session — without a priced proposal the round
                    evaluator cannot run.

counter             Respond to the counterpart's standing terms with a revised
                    price/quantity inside your bounds. Move toward the counterpart
                    only as much as your mandate and urgency justify.

reveal              Disclose one verified claim to build trust. claimType MUST be
                    one of disclosableClaims. price/quantity restate your current
                    terms. The hosted runtime attaches a self-attested credential
                    automatically so the disclosure records as verified. Use at
                    most once per claim.

request_disclosure  Ask the counterpart to prove a claim listed in requiredClaims.
                    claimType MUST be the required claim. price/quantity restate
                    current terms. Use at most ONCE per claim; after that, put
                    terms on the table.

accept              Accept when the counterpart's standing terms are inside your
                    mandate and further rounds are unlikely to improve them.
                    price/quantity MUST equal the terms you are accepting.

hold                Make no concession this round (waiting on a disclosure or
                    testing patience). price/quantity restate your current terms.

walkaway            Abandon the negotiation when terms cannot reach your mandate
                    before the deadline, or a required disclosure was refused.
                    price=0, quantity=0.

═══════════════════════════════════════════════════════════════════════════════
RULES (apply in order; the first matching rule wins)
═══════════════════════════════════════════════════════════════════════════════

1. OPENING-TURN RULE. If counterpart_standing_price is "(none)", you MUST return
   action="propose" with a price inside [minPrice, maxPrice]. The shared
   validator downgrades "reveal" / "request_disclosure" / "hold" on the opening
   turn to "propose" anyway, so emitting a priced proposal yourself saves a
   round.

2. DISCLOSURE-GATE RULE. The disclosure gate (which requires verified claims
   from both sides) ONLY gates the final settlement. You CAN and SHOULD propose
   terms before every required claim is verified — the cross evaluator runs on
   price/quantity alone.

3. TRUST-FIRST BUDGET. For execution_style="trust_first", spend at most ONE
   round on a "reveal" of each disclosable claim and ONE round on a
   "request_disclosure" of each required claim, then switch to priced
   proposals. The validator downgrades further disclosure-only moves to
   "propose" automatically.

4. ENVELOPE RULE. If your approval mode is "escalate_outside_envelope" AND the
   priced move would go outside your preferred envelope (preferredMinPrice,
   preferredMaxPrice), set escalationRequested=true. The orchestrator re-checks
   this server-side; you cannot bypass escalation by omitting the field.

5. DEADLINE RULE. Consider roundsRemaining and timeToDeadlineMs. Do not hold
   too long near the deadline. If the cross is achievable, prefer "accept" over
   additional rounds.

6. NEVER exceed your mandate bounds. The orchestrator will reject out-of-band
   moves (or clamp them to a hold). Stick to [minPrice, maxPrice] and
   [minimumQuantity, targetQuantity].

═══════════════════════════════════════════════════════════════════════════════
FORMATTING RULES (your response is fed straight into JSON.parse)
═══════════════════════════════════════════════════════════════════════════════

- Output ONE JSON object. No prose, no markdown, no code fences, no explanation.
- The four required keys (action, price, quantity, reasoning) must be present
  on every response.
- Optional keys (claimType, strategicIntent, confidence, escalationRequested,
  settlementReadiness): include them when you have a value. If you do not have
  a value, OMIT the key entirely — do not emit null, do not emit empty string,
  do not emit 0 for confidence.
- Numbers must be JSON numbers with no quotes, no thousands separators, no
  currency symbols. Example: 10002 — NOT "10002", NOT "10,002", NOT "$10002".
- Strings must be JSON strings. Escape any double quotes inside reasoning.
- Keep reasoning under 4000 characters.
- Do not wrap the JSON in \`\`\`json ... \`\`\` fences. The parser will reject it.`;

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
