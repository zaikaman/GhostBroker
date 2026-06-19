import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient } from "./auth-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { AuthSession } from "./types.js";

const SAMPLE_SESSION: AuthSession = {
  token: "gb_session_abc123",
  expiresAt: "2026-06-14T20:00:00.000Z",
  institution: {
    id: "00000000-0000-4000-8000-000000000101",
    displayName: "Northstar Capital",
    t3TenantDid: "did:t3n:0x0000000000000000000000000000000000000301",
  },
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

describe("AuthClient", () => {
  it("strips a trailing slash from the baseUrl", () => {
    const client = new AuthClient({ baseUrl: "https://api.example.com/" });
    // No public getter; the trailing-slash handling is exercised on every
    // request, see the URL assertions below.
    expect(client).toBeDefined();
  });

  describe("authenticateWithApiKey", () => {
    it("POSTs to /api/auth/api-key with the API key in the body and returns the session", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_SESSION));

      const client = new AuthClient({ baseUrl: "https://api.example.com" });
      const session = await client.authenticateWithApiKey("gbk_live_test");

      expect(session).toEqual(SAMPLE_SESSION);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const firstCall = fetchSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [url, init] = firstCall ?? [];
      expect(url).toBe("https://api.example.com/api/auth/api-key");
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect((reqInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(reqInit.body as string)).toEqual({ apiKey: "gbk_live_test" });
    });

    it("works with a baseUrl that has a trailing slash", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_SESSION));

      const client = new AuthClient({ baseUrl: "https://api.example.com/" });
      await client.authenticateWithApiKey("gbk_test");

      const firstCall = fetchSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [url] = firstCall ?? [];
      expect(url).toBe("https://api.example.com/api/auth/api-key");
    });

    it("throws a GhostBrokerApiError with the server-provided code on a 4xx response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(
          { code: "authorization_failed", message: "Unknown API key." },
          { status: 401 },
        ),
      );

      const client = new AuthClient({ baseUrl: "https://api.example.com" });

      let caught: unknown;
      try {
        await client.authenticateWithApiKey("gbk_bad");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(401);
      expect(e.code).toBe("authorization_failed");
      expect(e.message).toBe("Unknown API key.");
      expect(e.isAuthError).toBe(true);
    });

    it("falls back to 'request_failed' when the error body is not JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("not json", { status: 500, headers: { "Content-Type": "text/plain" } }),
      );

      const client = new AuthClient({ baseUrl: "https://api.example.com" });
      try {
        await client.authenticateWithApiKey("gbk_test");
        expect.fail("expected throw");
      } catch (err) {
        const e = err as GhostBrokerApiError;
        expect(e.status).toBe(500);
        expect(e.code).toBe("request_failed");
        expect(e.message).toBe("HTTP 500");
      }
    });
  });
});
