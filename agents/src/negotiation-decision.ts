import Groq from "groq-sdk";
import { z } from "zod";
import { extractJsonObject } from "./llm-decision.js";

/**
 * The bounded set of moves a negotiating agent may make on its
 * turn. This is the agent-side mirror of the backend's
 * `negotiationActionSchema`; the two must agree on the literal
 * action names. The enclave re-derives the authoritative effect
 * of each move — the agent only proposes one.
 */
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
  reasoning: z.string().max(280),
});

export type NegotiationDecision = z.infer<typeof negotiationDecisionSchema>;

/**
 * Everything the negotiating agent is allowed to see on its turn.
 * Critically this NEVER contains the counterparty's mandate,
 * private floor/ceiling, identity, or exact standing price — only
 * the redacted signals the backend exposes through
 * `RedactedNegotiationSessionView`. The agent reasons from its own
 * mandate plus those opaque signals.
 */
export interface NegotiationContext {
  side: "buy" | "sell";
  assetCode: string;
  quoteAssetCode: string;
  targetQuantity: number;
  referencePrice: number;
  priceBandBps: number;
  minPrice: number;
  maxPrice: number;
  maxNotional: number;
  urgency: "low" | "normal" | "high" | "critical";
  roundNumber: number;
  maxRounds: number;
  /** Opaque distance hint from the enclave: how far the sides are. */
  distanceSignal: "crossed" | "near" | "moderate" | "far" | null;
  /**
   * The counterparty's most recent standing price, IF the enclave
   * chose to surface it (it surfaces a coarse value, never the
   * counterparty's private limit). `null` early in a session.
   */
  counterpartStandingPrice: number | null;
  counterpartStandingQuantity: number | null;
  /** Claim types this agent's mandate permits it to disclose. */
  disclosableClaims: string[];
  /** Claim types already disclosed to this agent by the counterparty. */
  receivedClaims: string[];
  /** Claim types the counterparty still requires before converging. */
  requiredClaims: string[];
  operatorPrompt?: string;
  lastOutcome?: string;
}

const SYSTEM_PROMPT = `You are a hosted GhostBroker institutional negotiation agent.
You operate inside GhostBroker-managed confidential infrastructure.
You cannot see the counterparty's identity, mandate, private limit price, or queue.
You may only use the information provided for the current round.

You negotiate a single confidential block trade on behalf of your institution.
Each round you choose exactly one action and return strict JSON only.
Do not output prose, markdown, or code fences.

Actions:
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

Guidance:
  - Respect urgency: "critical" should converge faster and concede more; "low" can hold.
  - Never cross your own mandate bounds. The enclave will reject out-of-bounds moves.
  - Prefer "accept" over additional rounds once terms are acceptable; rounds are limited.

Output exactly:
{
  "action": "propose" | "counter" | "reveal" | "request_disclosure" | "accept" | "hold" | "walkaway",
  "price": <number>,
  "quantity": <number>,
  "claimType": "<optional claim type>",
  "reasoning": "<= 280 chars, plain text>"
}`;

function negotiationUserPrompt(ctx: NegotiationContext): string {
  return [
    `round: ${ctx.roundNumber}/${ctx.maxRounds}`,
    `side: ${ctx.side}`,
    `asset_code: ${ctx.assetCode}`,
    `quote_asset_code: ${ctx.quoteAssetCode}`,
    `target_quantity: ${ctx.targetQuantity}`,
    `reference_price: ${ctx.referencePrice}`,
    `price_band_bps: ${ctx.priceBandBps}`,
    `min_price: ${ctx.minPrice}`,
    `max_price: ${ctx.maxPrice}`,
    `max_notional: ${ctx.maxNotional}`,
    `urgency: ${ctx.urgency}`,
    `distance_signal: ${ctx.distanceSignal ?? "(unknown)"}`,
    `counterpart_standing_price: ${
      ctx.counterpartStandingPrice ?? "(none)"
    }`,
    `counterpart_standing_quantity: ${
      ctx.counterpartStandingQuantity ?? "(none)"
    }`,
    `disclosable_claims: ${
      ctx.disclosableClaims.length > 0 ? ctx.disclosableClaims.join(", ") : "(none)"
    }`,
    `received_claims: ${
      ctx.receivedClaims.length > 0 ? ctx.receivedClaims.join(", ") : "(none)"
    }`,
    `required_claims: ${
      ctx.requiredClaims.length > 0 ? ctx.requiredClaims.join(", ") : "(none)"
    }`,
    ctx.lastOutcome ? `last_round_outcome: ${ctx.lastOutcome}` : "last_round_outcome: (none)",
    ctx.operatorPrompt ? `operator_prompt: ${ctx.operatorPrompt}` : "operator_prompt: (none)",
  ].join("\n");
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function roundQty(quantity: number): number {
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

/**
 * Clamp an LLM-proposed move into the agent's mandate bounds. The
 * enclave is the authority and will reject anything out of bounds,
 * but clamping here keeps the agent honest and avoids burning a
 * round on a guaranteed-rejected move.
 */
export function clampNegotiationDecision(
  decision: NegotiationDecision,
  ctx: NegotiationContext,
): NegotiationDecision {
  const { action, reasoning } = decision;

  if (action === "walkaway") {
    return { action, price: 0, quantity: 0, reasoning };
  }

  // Disclosure-style moves restate current terms; validate the
  // claim type against the relevant allowlist.
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
        reasoning: "No disclosable claim available; holding instead.".slice(0, 280),
      };
    }
    return {
      action: "reveal",
      price: roundPrice(clampPrice(decision.price, ctx)),
      quantity: roundQty(clampQuantity(decision.quantity, ctx)),
      claimType,
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
        reasoning: "No outstanding required claim to request; holding instead.".slice(0, 280),
      };
    }
    return {
      action: "request_disclosure",
      price: roundPrice(clampPrice(decision.price, ctx)),
      quantity: roundQty(clampQuantity(decision.quantity, ctx)),
      claimType,
      reasoning,
    };
  }

  const price = clampPrice(decision.price, ctx);
  const quantity = clampQuantity(decision.quantity, ctx);

  // Enforce the per-trade notional ceiling. If the move exceeds it,
  // shrink quantity to fit rather than rejecting outright.
  let finalQuantity = quantity;
  if (price > 0 && price * finalQuantity > ctx.maxNotional) {
    finalQuantity = ctx.maxNotional / price;
  }

  return {
    action,
    price: roundPrice(price),
    quantity: roundQty(finalQuantity),
    reasoning,
  };
}

function clampPrice(price: number, ctx: NegotiationContext): number {
  return Math.max(ctx.minPrice, Math.min(ctx.maxPrice, price));
}

function clampQuantity(quantity: number, ctx: NegotiationContext): number {
  if (quantity <= 0) {
    return ctx.targetQuantity;
  }
  return Math.min(quantity, ctx.targetQuantity);
}

export interface NegotiationLlmClient {
  decide(ctx: NegotiationContext): Promise<NegotiationDecision>;
}

export class GroqNegotiationClient implements NegotiationLlmClient {
  private readonly client: Groq;
  private readonly model: string;
  private readonly temperature: number;

  public constructor(options: { apiKey: string; model: string; temperature?: number }) {
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
