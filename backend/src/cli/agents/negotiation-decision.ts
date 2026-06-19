import { z } from "zod";
import {
  validateAgentDecision,
  type AgentDecisionMove,
  type NegotiationTurnContext,
} from "../../negotiation-core/index.js";
import { extractJsonObject } from "./llm-decision.js";
import {
  AggregateLlmError,
  LlmProviderError,
  type FallbackEvent,
  type LlmProvider,
  type LlmRequest,
} from "./llm/index.js";

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
You operate inside GhostBroker-managed confidential infrastructure, on behalf
of an admitted institution. The platform has already verified your agent DID,
your delegated authority, and the institution's pre-cleared settlement
capacity before this loop started — settlement readiness is a launch fact,
not something you negotiate round by round.
You cannot see the counterparty's identity, mandate, private limit price, or queue.
You may only use the information provided for the current round.

You negotiate a single confidential block trade on behalf of your institution
inside mandate rails and a verifiable authority protocol. The disclosure gate
(buyer + seller required claims) is the ONLY thing that prevents settlement.
BOTH sides must reveal and verify every required claim — including
\`settlement_capacity\` — before the gate clears. Settlement capacity was
pre-cleared and attested by your institution before launch, so you CAN (and
SHOULD) reveal \`settlement_capacity\` at runtime via the action="reveal"
with claimType="settlement_capacity". The orchestrator accepts and verifies
revealed claims at runtime; requesting without reciprocating will deadlock
the disclosure gate permanently.

You own every action decision: action, price, quantity, claimType, strategic
intent, and rationale. No platform-side choreography guard overrides your
action choice (the shared validator still clamps prices/quantities to keep
you inside your mandate rails).

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
CRITICAL REMINDER (read this BEFORE the examples)
═══════════════════════════════════════════════════════════════════════════════

The three worked examples below show the SHAPE of a valid response. The
prices and quantities in the examples are ILLUSTRATIVE — they are NOT your
actual min_price, max_price, or target_quantity. You MUST use the EXACT
values from the "=== MANDATE ===" block of your user prompt. Do NOT copy
the example's prices or quantities. The LLM that wrote this prompt
intentionally uses values near min_price in the examples precisely so that
when you anchor on the example, you anchor on the right number — but
ONLY if your context's min_price matches the example's. If it doesn't,
use your own.

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 1 — opening turn, BUY side, no counterpart proposal yet
(hypothetical: min_price=10000, max_price=10075, target_quantity=0.0001,
execution_style="trust_first")
═══════════════════════════════════════════════════════════════════════════════

{
  "action": "propose",
  "price": 10000,
  "quantity": 0.0001,
  "strategicIntent": "open_patiently",
  "confidence": 0.85,
  "escalationRequested": false,
  "settlementReadiness": "not_ready",
  "reasoning": "Opening bid AT min_price (10000). Counterpart has not proposed yet — a priced move is required for the round evaluator to run. Bidding at min_price (not above) leaves the maximum room for the counterpart to counter and keeps the cross inside both mandates: the counterpart's walkaway ceiling is likely near the shared reference price (10000)."
}

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 2 — mid-game counter, BUY side, counterpart is at 10000
(hypothetical: min_price=10000, max_price=10075, target_quantity=0.0001)
═══════════════════════════════════════════════════════════════════════════════

{
  "action": "counter",
  "price": 10000,
  "quantity": 0.0001,
  "strategicIntent": "concede",
  "confidence": 0.7,
  "escalationRequested": false,
  "settlementReadiness": "near",
  "reasoning": "Counterpart is at 10000, which is at or near my min_price (10000). I restate 10000 to confirm the floor. If the counterpart holds at 10000, the cross is achievable and I can accept on the next round."
}

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE 3 — trust-first disclosure, SELL side, on the opening turn
(hypothetical: min_price=9925, max_price=10000, target_quantity=0.0001,
execution_style="trust_first", counterpart at 10002)
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
  "reasoning": "Execution style 'trust_first' requires verifying counterparty's accredited_institution status before progressing terms. One disclosure request, then back to priced proposals. Counterpart is at 10002; I restate my max (10000) to flag the spread."
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

2. OPENING-BID RULE. For your opening bid (or whenever you have no
   counterpart_standing_price to anchor against), use min_price. Bidding above
   min_price:
     - Wastes concession budget on the first move.
     - Pushes you above the counterpart's walkaway ceiling, making a cross
       impossible if the counterpart is anchored at their max.
     - Is the most common cause of agents walking away when a cross was
       actually achievable.
   The only exception is if min_price would trigger escalation under your
   approval policy — in that case, set escalationRequested=true and bid at
   min_price anyway. The shared validator clamps out-of-band prices back into
   the band, so any price above min_price is also above your walkaway floor
   and (often) above the counterpart's walkaway ceiling.

3. WALK-AWAY VERIFICATION. Before returning action="walkaway", you MUST have
   observed ALL of the following at least once during the session:
     a. counterpart_standing_price is set (the counterpart has placed at
        least one priced move).
     b. counterpart_standing_price is BELOW your min_price.
     c. roundsRemaining is low (≤ 3) OR timeToDeadlineMs is short
        (≤ 20% of the original deadline).
   If ANY of these is false, do NOT walk away. In particular: if the
   counterpart has only done disclosures so far (no priced move), they are
   still building trust per their mandate — not being resistant. Wait for
   their first priced move before concluding the deal is unreachable.

4. PATIENCE RULE (trust_first counterparties). If execution_style is
   "trust_first", expect the counterpart to spend up to 3-4 rounds on
   disclosures before placing a priced move. Do not walk away based on
   disclosure-only moves alone. Wait for the counterpart's first priced
   move, then evaluate against your min_price and preferred envelope.

5. CROSS-FEASIBILITY CHECK (the single most important rule). The derived
   price bands are constructed so that any priced move the counterpart
   submits is inside your own band:
     - For BUY side: counterpart_standing_price is the SELL's ask, which
       is in [walkawayMin, referencePrice]. Your band is
       [referencePrice, walkawayMax], so the SELL's ask is always inside
       yours (SELL ask <= referencePrice = your min <= your max).
     - For SELL side: counterpart_standing_price is the BUY's bid, which
       is in [referencePrice, walkawayMax]. Your band is
       [walkawayMin, referencePrice], so the BUY's bid is always inside
       yours (BUY bid >= referencePrice = your max >= your min).
   Therefore: when counterpart_standing_price is set (not "(none)"), the
   cross IS feasible. Return action="accept" with
   price=counterpart_standing_price and quantity=counterpart_standing_quantity.
   Do NOT keep proposing, countering, or holding when a cross is already
   feasible. The earlier wrong version of this rule compared the
   counterpart's price against your own min_price, which is the wrong
   axis for buy-side agents and caused the buyer to walk away from
   perfectly good sell-side offers.

6. DISCLOSURE-GATE RULE. The disclosure gate (which requires verified claims
   from both sides) ONLY gates the final settlement. You CAN and SHOULD propose
   terms before every required claim is verified — the cross evaluator runs on
   price/quantity alone. HOWEVER: do NOT return action="accept" while any
   required_claim remains unverified. If terms are otherwise good, use
   request_disclosure, reveal, or restate a priced proposal until the required
   claims are verified.

7. TRUST-FIRST BUDGET. For execution_style="trust_first", spend at most ONE
   round on a "reveal" of each disclosable claim and ONE round on a
   "request_disclosure" of each required claim, then switch to priced
   proposals. The validator downgrades further disclosure-only moves to
   "propose" automatically.

8. ENVELOPE RULE. If your approval mode is "escalate_outside_envelope" AND the
   priced move would go outside your preferred envelope (preferredMinPrice,
   preferredMaxPrice), set escalationRequested=true. The orchestrator re-checks
   this server-side; you cannot bypass escalation by omitting the field.

9. DEADLINE RULE. Consider roundsRemaining and timeToDeadlineMs. Do not hold
   too long near the deadline. If the cross is achievable, prefer "accept" over
   additional rounds.

10. RECIPROCITY RULE (critical for disclosure gate). The disclosure gate
    requires BOTH sides to have revealed and verified every required claim
    (typically \`accredited_institution\` AND \`settlement_capacity\`).
    Requesting a claim from the counterparty does NOT satisfy your side of
    the gate — you MUST also reveal your own version of that claim using
    action="reveal" with the claimType set. Plan your reveals in this order:
    first \`accredited_institution\`, then \`settlement_capacity\`. If you only
    request without reciprocating, the gate stays blocked forever.

11. NEVER exceed your mandate bounds. The orchestrator will reject out-of-band
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
    `prior_disclosure_requests_this_session: ${
      ctx.priorDisclosureRequests && ctx.priorDisclosureRequests.length > 0
        ? ctx.priorDisclosureRequests.join(", ")
        : "(none)"
    }`,
    `prior_disclosure_reveals_this_session: ${
      ctx.priorDisclosureReveals && ctx.priorDisclosureReveals.length > 0
        ? ctx.priorDisclosureReveals.join(", ")
        : "(none)"
    }`,    ``,
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
// LLM client interface & multi-provider implementation
// ---------------------------------------------------------------------------

export interface INegotiationLlmClient {
  decide(ctx: NegotiationContext): Promise<NegotiationDecision>;
  readonly providerIds: readonly string[];
}

export interface NegotiationLlmClientOptions {
  provider: LlmProvider;
  temperature?: number;
  topP?: number;
  /**
   * Optional listener invoked every time the chain falls back from
   * one provider to the next. Used by the negotiation loop's
   * `withRetries` wrapper to log which provider served each call.
   */
  onFallback?: (event: FallbackEvent) => void;
}

/**
 * Negotiation LLM client backed by the multi-provider fallback chain
 * (`gemini → openai → groq`). Same prompt is sent to every provider;
 * the chain only falls back on transient failures.
 *
 * `GroqNegotiationClient` (which wrapped the `groq-sdk` directly) was
 * retired in favour of this uniform client; see `agents/src/llm/`
 * for the per-provider implementations.
 */
export class NegotiationLlmClient implements INegotiationLlmClient {
  private readonly provider: LlmProvider;
  private readonly temperature: number;
  private readonly topP: number;

  public constructor(options: NegotiationLlmClientOptions) {
    if (!options.provider) {
      throw new Error("NegotiationLlmClient requires a non-null provider");
    }
    this.provider = options.provider;
    this.temperature = options.temperature ?? 0.5;
    this.topP = options.topP ?? 0.95;
  }

  public get providerIds(): readonly string[] {
    if ("providerIds" in this.provider && Array.isArray((this.provider as { providerIds?: unknown }).providerIds)) {
      return (this.provider as { providerIds: readonly string[] }).providerIds;
    }
    return [this.provider.id];
  }

  public async decide(ctx: NegotiationContext): Promise<NegotiationDecision> {
    const request: LlmRequest = {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: negotiationUserPrompt(ctx) },
      ],
      temperature: this.temperature,
      topP: this.topP,
    };

    let response;
    try {
      response = await this.provider.complete(request);
    } catch (err) {
      throw rethrowForAgentLoop(err);
    }

    const text = response.text;
    if (text.length === 0) {
      throw new Error(
        `LLM (${response.provider}/${response.model}) returned an empty negotiation completion`,
      );
    }
    const parsed = extractJsonObject(text);
    const validated = negotiationDecisionSchema.parse(parsed);
    return clampNegotiationDecision(validated, ctx);
  }
}

function rethrowForAgentLoop(err: unknown): Error {
  if (err instanceof AggregateLlmError) {
    return err;
  }
  if (err instanceof LlmProviderError) {
    return err;
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
