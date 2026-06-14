import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioClient } from "./portfolio-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { AgentPortfolio } from "./types.js";

const SAMPLE_PORTFOLIO: AgentPortfolio = {
  institutionId: "inst_123",
  agentDid: "did:t3n:agent:abc",
  holdings: [
    { assetCode: "USDC", balance: 1_000_000, locked: 100_000 },
    { assetCode: "WBTC", balance: 5, locked: 0 },
  ],
  pendingReservations: [
    {
      intentHandle: "intent_1",
      assetCode: "USDC",
      amount: 50_000,
      side: "buy",
      quantity: 1,
      price: 50_000,
    },
  ],
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

describe("PortfolioClient", () => {
  it("GETs /api/portfolios/:institutionId?agentDid=... with the bearer token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse(SAMPLE_PORTFOLIO));

    const client = new PortfolioClient("https://api.example.com");
    const result = await client.getPortfolio(
      { institutionId: "inst_123", agentDid: "did:t3n:agent:abc" },
      "gb_session_xyz",
    );

    expect(result).toEqual(SAMPLE_PORTFOLIO);

    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? [];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/api/portfolios/inst_123");
    expect(parsed.searchParams.get("agentDid")).toBe("did:t3n:agent:abc");
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("GET");
    expect((reqInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer gb_session_xyz",
    );
  });

  it("percent-encodes the institutionId path segment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse(SAMPLE_PORTFOLIO));

    const client = new PortfolioClient("https://api.example.com");
    await client.getPortfolio(
      { institutionId: "inst/with/slashes", agentDid: "did:t3n:agent:abc" },
      "tok",
    );

    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url] = firstCall ?? [];
    const parsed = new URL(url as string);
    // The slash in the institutionId must be percent-encoded so
    // Express does not treat it as a path separator.
    expect(parsed.pathname).toBe("/api/portfolios/inst%2Fwith%2Fslashes");
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockJsonResponse(SAMPLE_PORTFOLIO));

    const client = new PortfolioClient("https://api.example.com/");
    await client.getPortfolio(
      { institutionId: "inst_123", agentDid: "did:t3n:agent:abc" },
      "tok",
    );

    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url] = firstCall ?? [];
    expect(url).toBe(
      "https://api.example.com/api/portfolios/inst_123?agentDid=did%3At3n%3Aagent%3Aabc",
    );
  });

  it("throws a GhostBrokerApiError on 401 (not authenticated)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "authorization_failed", message: "Not authenticated" },
        { status: 401 },
      ),
    );

    const client = new PortfolioClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getPortfolio(
        { institutionId: "inst_123", agentDid: "did:t3n:agent:abc" },
        "tok",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(401);
    expect(e.code).toBe("authorization_failed");
    expect(e.isAuthError).toBe(true);
    expect(e.isRetryable).toBe(false);
  });

  it("throws a GhostBrokerApiError on 403 (wrong institution)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        {
          code: "authorization_failed",
          message: "You can only view your own institution's portfolio.",
        },
        { status: 403 },
      ),
    );

    const client = new PortfolioClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getPortfolio(
        { institutionId: "other_inst", agentDid: "did:t3n:agent:abc" },
        "tok",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(403);
    expect(e.code).toBe("authorization_failed");
    expect(e.isAuthError).toBe(true);
  });

  it("throws a GhostBrokerApiError on 400 (malformed agentDid)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "validation_failed", message: "Invalid query parameters." },
        { status: 400 },
      ),
    );

    const client = new PortfolioClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getPortfolio(
        { institutionId: "inst_123", agentDid: "not-a-did" },
        "tok",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("validation_failed");
  });

  it("throws a GhostBrokerApiError on 503 (service unavailable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "service_unavailable", message: "temporarily down" },
        { status: 503 },
      ),
    );

    const client = new PortfolioClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getPortfolio(
        { institutionId: "inst_123", agentDid: "did:t3n:agent:abc" },
        "tok",
      );
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
