import { describe, expect, it } from "vitest";
import { clampDecision, decisionSchema, extractJsonObject } from "./llm-decision.js";
import type { DecisionContext } from "./llm-decision.js";

const baseCtx: DecisionContext = {
  side: "buy",
  referencePriceUsdcPerWbtc: 70_000,
  priceBandBps: 200,
  quantityMinWbtc: 0.05,
  quantityMaxWbtc: 1.0,
  availableUsdc: 100_000,
  availableWbtc: 0,
  completedTradeCount: 0,
  tickNumber: 1,
  maxTicks: 40,
  lastOutcome: "(start of run)",
};

describe("extractJsonObject", () => {
  it("parses a clean JSON object", () => {
    expect(extractJsonObject('{"action":"wait","quantity":0,"price":70000,"reasoning":"x"}')).toEqual({
      action: "wait",
      quantity: 0,
      price: 70000,
      reasoning: "x",
    });
  });

  it("strips ```json fences", () => {
    const raw = "```json\n{\"action\":\"wait\",\"quantity\":0,\"price\":70000,\"reasoning\":\"x\"}\n```";
    expect(extractJsonObject(raw)).toEqual({
      action: "wait",
      quantity: 0,
      price: 70000,
      reasoning: "x",
    });
  });

  it("recovers from leading prose", () => {
    const raw = 'Sure, here is the JSON: {"action":"abort","quantity":0,"price":0,"reasoning":"stop"}';
    expect(extractJsonObject(raw)).toEqual({
      action: "abort",
      quantity: 0,
      price: 0,
      reasoning: "stop",
    });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("no json at all")).toThrow();
  });
});

describe("decisionSchema", () => {
  it("accepts a valid submit", () => {
    const parsed = decisionSchema.parse({
      action: "submit",
      quantity: 0.5,
      price: 70_500,
      reasoning: "good fit",
    });
    expect(parsed.action).toBe("submit");
  });

  it("accepts a valid wait with zero quantity", () => {
    const parsed = decisionSchema.parse({
      action: "wait",
      quantity: 0,
      price: 70_000,
      reasoning: "observing",
    });
    expect(parsed.action).toBe("wait");
    expect(parsed.quantity).toBe(0);
  });

  it("accepts a valid abort with zero quantity and price", () => {
    const parsed = decisionSchema.parse({
      action: "abort",
      quantity: 0,
      price: 0,
      reasoning: "stopping",
    });
    expect(parsed.action).toBe("abort");
    expect(parsed.quantity).toBe(0);
    expect(parsed.price).toBe(0);
  });

  it("rejects an unknown action", () => {
    expect(() =>
      decisionSchema.parse({
        action: "explode",
        quantity: 0,
        price: 0,
        reasoning: "no",
      }),
    ).toThrow();
  });

  it("rejects a negative quantity", () => {
    expect(() =>
      decisionSchema.parse({
        action: "submit",
        quantity: -1,
        price: 70_000,
        reasoning: "no",
      }),
    ).toThrow();
  });

  it("rejects a too-long reasoning", () => {
    expect(() =>
      decisionSchema.parse({
        action: "wait",
        quantity: 0,
        price: 70_000,
        reasoning: "x".repeat(281),
      }),
    ).toThrow();
  });
});

describe("clampDecision (buy side)", () => {
  it("clamps price above the upper band", () => {
    const out = clampDecision(
      { action: "submit", quantity: 0.1, price: 999_999, reasoning: "ambitious" },
      baseCtx,
    );
    expect(out.action).toBe("submit");
    expect(out.price).toBeLessThanOrEqual(70_000 * 1.02 + 0.005);
    expect(out.price).toBeGreaterThan(70_000);
  });

  it("clamps price below the lower band", () => {
    const out = clampDecision(
      { action: "submit", quantity: 0.1, price: 1, reasoning: "penny" },
      baseCtx,
    );
    expect(out.action).toBe("submit");
    expect(out.price).toBeGreaterThanOrEqual(70_000 * 0.98 - 0.005);
  });

  it("clamps quantity above the maximum", () => {
    const out = clampDecision(
      { action: "submit", quantity: 99, price: 70_000, reasoning: "moar" },
      baseCtx,
    );
    expect(out.action).toBe("submit");
    expect(out.quantity).toBeLessThanOrEqual(1.0);
  });

  it("downgrades to wait when notional exceeds available USDC", () => {
    const tightCtx: DecisionContext = { ...baseCtx, availableUsdc: 100 };
    const out = clampDecision(
      { action: "submit", quantity: 1.0, price: 70_000, reasoning: "all in" },
      tightCtx,
    );
    expect(out.action).toBe("wait");
    expect(out.reasoning).toMatch(/Insufficient USDC/u);
  });

  it("scales quantity down to fit a tight USDC budget", () => {
    const tightCtx: DecisionContext = { ...baseCtx, availableUsdc: 35_000 };
    const out = clampDecision(
      { action: "submit", quantity: 1.0, price: 70_000, reasoning: "big" },
      tightCtx,
    );
    expect(out.action).toBe("submit");
    expect(out.quantity).toBeCloseTo(0.5, 5);
  });
});

describe("clampDecision (sell side)", () => {
  const sellCtx: DecisionContext = { ...baseCtx, side: "sell", availableUsdc: 0, availableWbtc: 5 };

  it("clamps quantity above available WBTC", () => {
    const out = clampDecision(
      { action: "submit", quantity: 99, price: 70_000, reasoning: "everything" },
      sellCtx,
    );
    expect(out.action).toBe("submit");
    expect(out.quantity).toBeLessThanOrEqual(5);
  });

  it("downgrades to wait when WBTC is below the minimum", () => {
    const tooLittle: DecisionContext = { ...sellCtx, availableWbtc: 0.01 };
    const out = clampDecision(
      { action: "submit", quantity: 1, price: 70_000, reasoning: "hope" },
      tooLittle,
    );
    expect(out.action).toBe("wait");
  });
});

describe("clampDecision (wait + abort)", () => {
  it("preserves abort", () => {
    const out = clampDecision(
      { action: "abort", quantity: 999, price: 999, reasoning: "done" },
      baseCtx,
    );
    expect(out.action).toBe("abort");
    expect(out.quantity).toBe(0);
    expect(out.price).toBe(0);
  });

  it("preserves wait", () => {
    const out = clampDecision(
      { action: "wait", quantity: 5, price: 1, reasoning: "patience" },
      baseCtx,
    );
    expect(out.action).toBe("wait");
    expect(out.quantity).toBe(0);
    expect(out.price).toBe(baseCtx.referencePriceUsdcPerWbtc);
  });
});
