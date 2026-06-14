import { afterEach, describe, expect, it, vi } from "vitest";
import { TradesClient } from "./trades-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { CompletedTrade } from "./types.js";

const SAMPLE_TRADE: CompletedTrade = {
  id: "uuid-1",
  tradeRef: "t3exec_abc",
  assetCodeCiphertext: "t3cipher.abc.sealed",
  quantityCiphertext: "t3cipher.def.sealed",
  executionPriceCiphertext: "t3cipher.ghi.sealed",
  settledAt: "2026-06-14T10:00:00.000Z",
  settlementStatus: "settled",
  receiptIds: ["uuid-of-receipt"],
};

function mockJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TradesClient", () => {
  it("GETs /api/trades/completed with the bearer token and returns the items", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse({ items: [SAMPLE_TRADE] }));

    const client = new TradesClient("https://api.example.com");
    const result = await client.getCompletedTrades("gb_session_xyz");

    expect(result).toEqual({ items: [SAMPLE_TRADE] });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/api/trades/completed");
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("GET");
    expect((reqInit.headers as Record<string, string>).Authorization).toBe("Bearer gb_session_xyz");
  });

  it("appends `from` and `to` query parameters when provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse({ items: [] }));

    const client = new TradesClient("https://api.example.com");
    await client.getCompletedTrades("tok", {
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-15T00:00:00.000Z",
    });

    const [url] = fetchSpy.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/api/trades/completed");
    expect(parsed.searchParams.get("from")).toBe("2026-06-01T00:00:00.000Z");
    expect(parsed.searchParams.get("to")).toBe("2026-06-15T00:00:00.000Z");
  });

  it("omits `from` and `to` query parameters when not provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse({ items: [] }));

    const client = new TradesClient("https://api.example.com");
    await client.getCompletedTrades("tok");

    const [url] = fetchSpy.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.search).toBe("");
  });

  it("throws a GhostBrokerApiError on a 5xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "service_unavailable", message: "temporarily down" },
        { status: 503 },
      ),
    );

    const client = new TradesClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getCompletedTrades("tok");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(503);
    expect(e.code).toBe("service_unavailable");
    expect(e.isRetryable).toBe(true);
  });
});
