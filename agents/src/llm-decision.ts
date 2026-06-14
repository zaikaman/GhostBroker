import Groq from "groq-sdk";
import { z } from "zod";

/**
 * The decision the LLM returns. Forced to a strict shape by the system
 * prompt and re-validated by zod after parsing, so a chatty or
 * misformatted response never silently slips into the trade path.
 */
export const decisionSchema = z.object({
  action: z.enum(["submit", "wait", "abort"]),
  /** WBTC quantity, between the configured min and max. */
  quantity: z.number().positive(),
  /** USDC price per WBTC, within the configured band around the reference. */
  price: z.number().positive(),
  /** A free-text rationale, capped at 280 chars so the log line stays sane. */
  reasoning: z.string().max(280),
});

export type Decision = z.infer<typeof decisionSchema>;

export interface DecisionContext {
  side: "buy" | "sell";
  referencePriceUsdcPerWbtc: number;
  priceBandBps: number;
  quantityMinWbtc: number;
  quantityMaxWbtc: number;
  /** USDC currently available (balance minus locked) for the agent's institution. */
  availableUsdc: number;
  /** WBTC currently available for the agent's institution. */
  availableWbtc: number;
  /** Number of completed trades this institution has participated in (read from API). */
  completedTradeCount: number;
  /** Tick number, 1-indexed, included in the prompt so the LLM can see progression. */
  tickNumber: number;
  /** Max ticks before the agent gives up. */
  maxTicks: number;
  /** What happened on the previous tick, if anything. */
  lastOutcome?: string;
}

const SYSTEM_PROMPT = `You are a trading agent inside the GhostBroker institutional dark pool.
You see only your own institution's portfolio, your own prior intents,
and a public reference price for WBTC quoted in USDC.
You cannot see other participants' orders, prices, or queues.

Your job on every tick: pick ONE of three actions and output strict JSON.
Do not output prose, markdown, code fences, or any text outside the JSON.

Actions:
  - "submit":  place an intent. Choose a WBTC quantity and a USDC price
                that fall inside the supplied bounds. Your price must
                be inside [minPrice, maxPrice]. Your quantity must be
                inside [quantityMin, quantityMax]. If your side is
                "buy", the implied USDC notional (quantity * price)
                must not exceed availableUsdc. If your side is
                "sell", the quantity must not exceed availableWbtc.
  - "wait":    do nothing this tick. Output quantity = 0, price =
                referencePrice. Use this when the market is unfavorable
                or you want to observe more.
  - "abort":   stop the loop. Output quantity = 0, price = 0.
                Use this only if you detect a structural problem with
                the platform (repeated 5xx, missing credentials, etc).

Output schema (return EXACTLY this JSON, no other text):
{
  "action": "submit" | "wait" | "abort",
  "quantity": <number>,
  "price": <number>,
  "reasoning": "<= 280 chars, plain text, no markdown>"
}`;

const userPromptTemplate = (ctx: DecisionContext): string => {
  const minPrice = roundPrice(
    ctx.referencePriceUsdcPerWbtc * (1 - ctx.priceBandBps / 10_000),
  );
  const maxPrice = roundPrice(
    ctx.referencePriceUsdcPerWbtc * (1 + ctx.priceBandBps / 10_000),
  );
  return [
    `tick: ${ctx.tickNumber}/${ctx.maxTicks}`,
    `side: ${ctx.side}`,
    `reference_price_usdc_per_wbtc: ${ctx.referencePriceUsdcPerWbtc}`,
    `price_band_bps: ${ctx.priceBandBps}`,
    `min_price: ${minPrice}`,
    `max_price: ${maxPrice}`,
    `quantity_min_wbtc: ${ctx.quantityMinWbtc}`,
    `quantity_max_wbtc: ${ctx.quantityMaxWbtc}`,
    `available_usdc: ${ctx.availableUsdc}`,
    `available_wbtc: ${ctx.availableWbtc}`,
    `completed_trade_count: ${ctx.completedTradeCount}`,
    ctx.lastOutcome ? `last_tick_outcome: ${ctx.lastOutcome}` : "last_tick_outcome: (none)",
  ].join("\n");
};

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

/**
 * Strip markdown code fences and any leading prose. Tolerant of the
 * model emitting ```json ...``` or wrapping in extra text. The returned
 * string is fed into `JSON.parse`; a parse failure is a hard error
 * and the agent falls back to "wait".
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const candidate = fenced ? fenced[1] : trimmed;

  // Try the full candidate first.
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back: find the first '{' and the matching '}'.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LLM response did not contain a JSON object");
  }
}

/**
 * The trade-floor safety net. After the LLM emits a decision we clamp
 * it to the configured bounds. A buyer's price never goes above
 * maxPrice; a seller's price never goes below minPrice. A submit
 * decision is downgraded to "wait" if the implied notional exceeds
 * available balance.
 */
export function clampDecision(decision: Decision, ctx: DecisionContext): Decision {
  const minPrice = ctx.referencePriceUsdcPerWbtc * (1 - ctx.priceBandBps / 10_000);
  const maxPrice = ctx.referencePriceUsdcPerWbtc * (1 + ctx.priceBandBps / 10_000);

  const { action, quantity: rawQuantity, price: rawPrice } = decision;
  let quantity = rawQuantity;
  let price = rawPrice;
  let { reasoning } = decision;

  if (action === "abort") {
    return { action: "abort", quantity: 0, price: 0, reasoning };
  }

  if (action === "wait") {
    return { action: "wait", quantity: 0, price: ctx.referencePriceUsdcPerWbtc, reasoning };
  }

  // action === "submit"
  quantity = Math.max(ctx.quantityMinWbtc, Math.min(ctx.quantityMaxWbtc, quantity));
  price = Math.max(minPrice, Math.min(maxPrice, price));

  if (ctx.side === "buy") {
    const notional = quantity * price;
    if (notional > ctx.availableUsdc) {
      // Scale quantity down to fit available USDC; if even the minimum
      // quantity doesn't fit, downgrade to "wait".
      const maxQuantityForBudget = ctx.availableUsdc / price;
      if (maxQuantityForBudget < ctx.quantityMinWbtc) {
        return {
          action: "wait",
          quantity: 0,
          price: ctx.referencePriceUsdcPerWbtc,
          reasoning: `Insufficient USDC: ${ctx.availableUsdc} < min notional ${(ctx.quantityMinWbtc * price).toFixed(2)}.`,
        };
      }
      quantity = Math.min(quantity, maxQuantityForBudget);
      reasoning = `${reasoning} [clamped to fit USDC budget]`.slice(0, 280);
    }
  } else {
    // side === "sell"
    if (quantity > ctx.availableWbtc) {
      if (ctx.availableWbtc < ctx.quantityMinWbtc) {
        return {
          action: "wait",
          quantity: 0,
          price: ctx.referencePriceUsdcPerWbtc,
          reasoning: `Insufficient WBTC: ${ctx.availableWbtc} < min quantity ${ctx.quantityMinWbtc}.`,
        };
      }
      quantity = Math.min(quantity, ctx.availableWbtc);
      reasoning = `${reasoning} [clamped to available WBTC]`.slice(0, 280);
    }
  }

  return {
    action: "submit",
    quantity: roundQty(quantity),
    price: roundPrice(price),
    reasoning,
  };
}

function roundQty(qty: number): number {
  // 6 decimal places is plenty for WBTC satoshi-level precision.
  return Math.round(qty * 1_000_000) / 1_000_000;
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
