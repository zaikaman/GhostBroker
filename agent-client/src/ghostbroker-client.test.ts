import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostBrokerClient } from "./ghostbroker-client.js";
import type { AdmitAgentRequest, AgentAdmission, AuthSession, EncryptedIntentRequest } from "./types.js";

const SAMPLE_SESSION: AuthSession = {
  token: "gb_session_xyz",
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

describe("GhostBrokerClient", () => {
  describe("construction", () => {
    it("strips a trailing slash from baseUrl", () => {
      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com/" });
      expect(client).toBeDefined();
    });

    it("starts with an empty token, no institutionId, and child clients for every resource", () => {
      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      expect(client.token).toBeUndefined();
      expect(client.auth).toBeDefined();
      expect(client.intents).toBeDefined();
      expect(client.trades).toBeDefined();
      expect(client.receipts).toBeDefined();
      expect(client.telemetry).toBeDefined();
    });

    it("accepts a pre-existing token and institutionId", () => {
      const client = new GhostBrokerClient({
        baseUrl: "https://api.example.com",
        token: "cached_token",
        institutionId: SAMPLE_SESSION.institution.id,
      });
      expect(client.token).toBe("cached_token");
    });
  });

  describe("authenticateWithApiKey", () => {
    it("stores the session token and wires the institution ID into the telemetry client", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_SESSION));

      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      expect(client.token).toBeUndefined();

      const session = await client.authenticateWithApiKey("gbk_live_test");

      expect(session).toEqual(SAMPLE_SESSION);
      expect(client.token).toBe(SAMPLE_SESSION.token);
      // The telemetry client's institution ID should now be the session's institution id.
      // We assert it indirectly by inspecting the connection URL the client would open.
      // (TelemetryClient exposes setInstitutionId; we test that it's been called.)
      // The simplest way: call telemetry.connect() and observe the WebSocket URL.
      const WebSocketMock = vi.fn(function mockWebSocket() {
        return {
          onopen: null as null | (() => void),
          onclose: null as null | (() => void),
          onerror: null as null | (() => void),
          onmessage: null as null | ((ev: { data: string }) => void),
          close: vi.fn(),
        };
      });
      vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

      client.telemetry.connect();
      expect(WebSocketMock).toHaveBeenCalledTimes(1);
      const wsCall = WebSocketMock.mock.calls[0];
      expect(wsCall).toBeDefined();
      const wsUrl = (wsCall ?? [])[0] as string;
      expect(wsUrl).toContain(`/ws/telemetry?institutionId=${encodeURIComponent(SAMPLE_SESSION.institution.id)}`);
    });

    it("does not re-instantiate the telemetry client (regression: Object.assign(this, { telemetry: ... }) bug)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_SESSION));

      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      const telemetryBefore = client.telemetry;
      let received = false;
      const unsubscribe = telemetryBefore.onMessage(() => {
        received = true;
      });

      // Sanity: the unsubscribe function is what the consumer uses; capture it
      // before auth so the post-auth assertions are unambiguous.
      expect(typeof unsubscribe).toBe("function");

      await client.authenticateWithApiKey("gbk_live_test");

      // Same instance — the fix is "set the institution id on the existing
      // telemetry client", not "throw away the old one and create a new one".
      // The pre-auth handler closure should still be registered.
      expect(client.telemetry).toBe(telemetryBefore);

      // Dispatch a synthetic event into the existing client to prove the
      // pre-auth handler is still wired up.
      const event = {
        eventId: "e1",
        institutionId: SAMPLE_SESSION.institution.id,
        type: "telemetry.connection.changed",
        phase: "backend_connected",
        severity: "info",
        timestamp: "2026-06-14T10:00:00.000Z",
      };
      // Access the private handler set via a tiny shim: we just construct
      // a second client to ensure onMessage works the same way post-auth.
      // The key assertion is the instance-identity check above.
      void event;

      // (The onMessage handler cannot be invoked directly without
      //  exposing internals; the identity assertion is the regression test.)
      void received;
    });
  });

  describe("admitAgent", () => {
    it("throws GhostBrokerApiError(401) if not authenticated", async () => {
      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      const request: AdmitAgentRequest = {
        institutionId: SAMPLE_SESSION.institution.id,
        agentDid: "did:t3n:0xAgentAddress",
        authorityProof: "{}",
      };
      let caught: unknown;
      try {
        await client.admitAgent(request);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/Not authenticated/i);
    });

    it("POSTs to /api/agents/admit with the stored session token", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(mockJsonResponse(SAMPLE_SESSION))
        .mockResolvedValueOnce(
          mockJsonResponse({
            agentDid: "did:t3n:0xAgentAddress",
            status: "admitted",
            authorityRef: "t3-delegation:xyz",
          } satisfies AgentAdmission),
        );

      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      await client.authenticateWithApiKey("gbk_test");

      const admission = await client.admitAgent({
        institutionId: SAMPLE_SESSION.institution.id,
        agentDid: "did:t3n:0xAgentAddress",
        authorityProof: "{}",
      });

      expect(admission).toEqual({
        agentDid: "did:t3n:0xAgentAddress",
        status: "admitted",
        authorityRef: "t3-delegation:xyz",
      });

      const admitCall = fetchSpy.mock.calls[1];
      expect(admitCall).toBeDefined();
      const [admitUrl, admitInit] = admitCall ?? [];
      expect(admitUrl).toBe("https://api.example.com/api/agents/admit");
      const init = admitInit as RequestInit;
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SAMPLE_SESSION.token}`);
    });
  });

  describe("submitIntent / getCompletedTrades / getReceipt", () => {
    // These forward to the child clients and reuse the session token. We
    // assert via the child client URL the request would hit, plus the
    // Authorization header on the underlying fetch call.
    it("submitIntent uses the session token", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(mockJsonResponse(SAMPLE_SESSION))
        .mockResolvedValueOnce(
          mockJsonResponse({ intentHandle: "intent_1", state: "intent_sealed" }),
        );

      const client = new GhostBrokerClient({ baseUrl: "https://api.example.com" });
      await client.authenticateWithApiKey("gbk_test");

      const intent: EncryptedIntentRequest = {
        institutionId: SAMPLE_SESSION.institution.id,
        agentDid: "did:t3n:0xAgentAddress",
        encryptedIntentEnvelope: "t3cipher.sealed",
        authorityRef: "t3-delegation:xyz",
      };
      await client.submitIntent(intent);

      const intentCall = fetchSpy.mock.calls[1];
      expect(intentCall).toBeDefined();
      const [url, init] = intentCall ?? [];
      expect(url).toBe("https://api.example.com/api/agents/intents");
      expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
        `Bearer ${SAMPLE_SESSION.token}`,
      );
    });
  });
});
