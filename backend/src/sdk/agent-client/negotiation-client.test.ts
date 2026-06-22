import { afterEach, describe, expect, it, vi } from "vitest";
import { NegotiationClient } from "./negotiation-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { NegotiationMove } from "./types.js";

const BASE = "https://api.example.com";
const TOKEN = "gb_session_xyz";
const SESSION_ID = "sess_001";

const TICKET_REQUEST = {
  agentId: "00000000-0000-4000-8000-000000000001",
  agentDid: "did:t3n:0xAgentAddress",
  policyHash: "sha256:policy",
  assetCode: "GHOST-IX",
  side: "buy" as const,
  compatibilityToken: "compat-tok",
};

const TICKET_ACCEPTED = {
  ticketHandle: "ticket_abc",
  sessionId: "sess_001",
};

const MOVE: NegotiationMove = {
  action: "propose",
  price: 102.5,
  quantity: 10,
  proposalEnvelope: "t3cipher.sealed.envelope",
  reasoning: "Initial patient proposal.",
};

const MOVE_REQUEST = {
  agentId: "00000000-0000-4000-8000-000000000001",
  agentDid: "did:t3n:0xAgentAddress",
  authorityRef: "t3-delegation:abc",
  move: MOVE,
};

const MOVE_ACCEPTED = { status: "active" as const };

const ESCALATION_RESULT = { status: "awaiting_approval" as const };

function mockJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return init?.headers as Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NegotiationClient", () => {
  describe("submitTicket", () => {
    it("POSTs to /api/negotiations/tickets with the bearer token and returns the accepted ticket", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonResponse(TICKET_ACCEPTED));

      const client = new NegotiationClient(BASE);
      const result = await client.submitTicket(TICKET_REQUEST, TOKEN);

      expect(result).toEqual(TICKET_ACCEPTED);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE}/api/negotiations/tickets`);
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(headersOf(reqInit).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headersOf(reqInit)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(reqInit.body as string)).toEqual(TICKET_REQUEST);
    });

    it("strips a trailing slash from the baseUrl", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonResponse(TICKET_ACCEPTED));

      const client = new NegotiationClient(`${BASE}/`);
      await client.submitTicket(TICKET_REQUEST, TOKEN);

      const [url] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE}/api/negotiations/tickets`);
    });

    it("throws a GhostBrokerApiError on a 4xx response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(
          { code: "validation_failed", message: "compatibility token stale" },
          { status: 400 },
        ),
      );

      const client = new NegotiationClient(BASE);
      let caught: unknown;
      try {
        await client.submitTicket(TICKET_REQUEST, TOKEN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("validation_failed");
    });

    it("falls back to request_failed when the error body is not JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("upstream down", { status: 502 }),
      );

      const client = new NegotiationClient(BASE);
      let caught: unknown;
      try {
        await client.submitTicket(TICKET_REQUEST, TOKEN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(502);
      expect(e.code).toBe("request_failed");
    });
  });

  describe("submitMove", () => {
    it("POSTs to /api/negotiations/:id/moves with the bearer token and returns the accepted move", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonResponse(MOVE_ACCEPTED));

      const client = new NegotiationClient(BASE);
      const result = await client.submitMove(SESSION_ID, MOVE_REQUEST, TOKEN);

      expect(result).toEqual(MOVE_ACCEPTED);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE}/api/negotiations/${SESSION_ID}/moves`);
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(headersOf(reqInit).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headersOf(reqInit)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(reqInit.body as string)).toEqual(MOVE_REQUEST);
    });

    it("throws a GhostBrokerApiError on a 5xx response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(
          { code: "upstream_unavailable", message: "TEE unreachable" },
          { status: 503 },
        ),
      );

      const client = new NegotiationClient(BASE);
      let caught: unknown;
      try {
        await client.submitMove(SESSION_ID, MOVE_REQUEST, TOKEN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(503);
      expect(e.code).toBe("upstream_unavailable");
    });
  });

  describe("approveEscalation", () => {
    it("POSTs to /api/negotiations/:id/escalation/approve with the bearer token and no body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonResponse(ESCALATION_RESULT));

      const client = new NegotiationClient(BASE);
      const result = await client.approveEscalation(SESSION_ID, TOKEN);

      expect(result).toEqual(ESCALATION_RESULT);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE}/api/negotiations/${SESSION_ID}/escalation/approve`);
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(headersOf(reqInit).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(reqInit.body).toBeUndefined();
    });

    it("throws a GhostBrokerApiError on a 409 conflict", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(
          { code: "conflict", message: "escalation already resolved" },
          { status: 409 },
        ),
      );

      const client = new NegotiationClient(BASE);
      let caught: unknown;
      try {
        await client.approveEscalation(SESSION_ID, TOKEN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe("conflict");
    });
  });

  describe("declineEscalation", () => {
    it("POSTs to /api/negotiations/:id/escalation/decline with reason body and bearer token", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonResponse(ESCALATION_RESULT));

      const client = new NegotiationClient(BASE);
      const result = await client.declineEscalation(SESSION_ID, { reason: "terms unsafe" }, TOKEN);

      expect(result).toEqual(ESCALATION_RESULT);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE}/api/negotiations/${SESSION_ID}/escalation/decline`);
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(headersOf(reqInit).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headersOf(reqInit)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(reqInit.body as string)).toEqual({ reason: "terms unsafe" });
    });

    it("throws a GhostBrokerApiError on a 401 unauthorized", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(
          { code: "unauthorized", message: "token revoked" },
          { status: 401 },
        ),
      );

      const client = new NegotiationClient(BASE);
      let caught: unknown;
      try {
        await client.declineEscalation(SESSION_ID, {}, TOKEN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GhostBrokerApiError);
      const e = caught as GhostBrokerApiError;
      expect(e.status).toBe(401);
      expect(e.code).toBe("unauthorized");
    });
  });
});
