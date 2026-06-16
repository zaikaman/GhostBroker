import Groq from "groq-sdk";
import { z } from "zod";

export const decisionSchema = z.object({
  action: z.enum(["submit", "wait", "abort"]),
  quantity: z.number().nonnegative(),
  price: z.number().nonnegative(),
  reasoning: z.string().max(280),
});

export type Decision = z.infer<typeof decisionSchema>;

export interface DecisionContext {
  side: "buy" | "sell";
  assetCode: string;
  quoteAssetCode: string;
  referencePrice: number;
  priceBandBps: number;
  minPrice: number;
  maxPrice: number;
  quantityMin: number;
  quantityMax: number;
  availableQuoteBalance: number;
  availableBaseBalance: number;
  completedTradeCount: number;
  tickNumber: number;
  maxTicks: number;
  lastOutcome?: string;
  operatorPrompt?: string;
}

const SYSTEM_PROMPT = `You are a hosted GhostBroker institutional trading agent.
You operate inside GhostBroker-managed confidential infrastructure.
You cannot see other participants' orders, prices, queues, or identities.
You may only use the information provided in the current tick.

On each tick, choose exactly one action and return strict JSON only.
Do not output prose, markdown, or code fences.

Actions:
  - "submit": place an intent using a quantity inside [quantityMin, quantityMax]
               and a price inside [minPrice, maxPrice].
               If side is "buy", quantity * price must not exceed availableQuoteBalance.
               If side is "sell", quantity must not exceed availableBaseBalance.
  - "wait":   do nothing this tick. Output quantity = 0 and price = referencePrice.
  - "abort":  stop the loop only when there is a structural platform problem.
               Output quantity = 0 and price = 0.

Output exactly:
{
  "action": "submit" | "wait" | "abort",
  "quantity": <number>,
  "price": <number>,
  "reasoning": "<= 280 chars, plain text>"
}`;

function userPromptTemplate(ctx: DecisionContext): string {
  return [
    `tick: ${ctx.tickNumber}/${ctx.maxTicks}`,
    `side: ${ctx.side}`,
    `asset_code: ${ctx.assetCode}`,
    `quote_asset_code: ${ctx.quoteAssetCode}`,
    `reference_price: ${ctx.referencePrice}`,
    `price_band_bps: ${ctx.priceBandBps}`,
    `min_price: ${ctx.minPrice}`,
    `max_price: ${ctx.maxPrice}`,
    `quantity_min: ${ctx.quantityMin}`,
    `quantity_max: ${ctx.quantityMax}`,
    `available_quote_balance: ${ctx.availableQuoteBalance}`,
    `available_base_balance: ${ctx.availableBaseBalance}`,
    `completed_trade_count: ${ctx.completedTradeCount}`,
    ctx.lastOutcome ? `last_tick_outcome: ${ctx.lastOutcome}` : "last_tick_outcome: (none)",
    ctx.operatorPrompt
      ? `operator_prompt: ${ctx.operatorPrompt}`
      : "operator_prompt: (none)",
  ].join("\n");
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function roundQty(quantity: number): number {
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LLM response did not contain a JSON object");
  }
}

export function clampDecision(decision: Decision, ctx: DecisionContext): Decision {
  const { action, quantity: rawQuantity, price: rawPrice } = decision;
  let quantity = rawQuantity;
  let price = rawPrice;
  let { reasoning } = decision;

  if (action === "abort") {
    return { action: "abort", quantity: 0, price: 0, reasoning };
  }

  if (action === "wait") {
    return { action: "wait", quantity: 0, price: roundPrice(ctx.referencePrice), reasoning };
  }

  quantity = Math.max(ctx.quantityMin, Math.min(ctx.quantityMax, quantity));
  price = Math.max(ctx.minPrice, Math.min(ctx.maxPrice, price));

  if (ctx.side === "buy") {
    const notional = quantity * price;
    if (notional > ctx.availableQuoteBalance) {
      const maxQuantityForBudget = ctx.availableQuoteBalance / price;
      if (maxQuantityForBudget < ctx.quantityMin) {
        return {
          action: "wait",
          quantity: 0,
          price: roundPrice(ctx.referencePrice),
          reasoning: `Insufficient ${ctx.quoteAssetCode} balance for minimum notional.`,
        };
      }
      quantity = Math.min(quantity, maxQuantityForBudget);
      reasoning = `${reasoning} [clamped to quote balance]`.slice(0, 280);
    }
  } else if (quantity > ctx.availableBaseBalance) {
    if (ctx.availableBaseBalance < ctx.quantityMin) {
      return {
        action: "wait",
        quantity: 0,
        price: roundPrice(ctx.referencePrice),
        reasoning: `Insufficient ${ctx.assetCode} balance for minimum quantity.`,
      };
    }
    quantity = Math.min(quantity, ctx.availableBaseBalance);
    reasoning = `${reasoning} [clamped to base balance]`.slice(0, 280);
  }

  return {
    action: "submit",
    quantity: roundQty(quantity),
    price: roundPrice(price),
    reasoning,
  };
}

export interface LlmClient {
  decide(ctx: DecisionContext): Promise<Decision>;
}

export class GroqLlmClient implements LlmClient {
  private readonly client: Groq;
  private readonly model: string;
  private readonly temperature: number;

  public constructor(options: { apiKey: string; model: string; temperature?: number }) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error("GroqLlmClient requires a non-empty apiKey");
    }
    this.client = new Groq({ apiKey: options.apiKey });
    this.model = options.model;
    this.temperature = options.temperature ?? 0.6;
  }

  public async decide(ctx: DecisionContext): Promise<Decision> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      top_p: 0.95,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPromptTemplate(ctx) },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    if (raw.length === 0) {
      throw new Error("Groq returned an empty completion");
    }
    const parsed = extractJsonObject(raw);
    const validated = decisionSchema.parse(parsed);
    return clampDecision(validated, ctx);
  }
}
