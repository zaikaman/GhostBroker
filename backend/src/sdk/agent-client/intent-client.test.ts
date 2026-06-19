import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentClient } from "./intent-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { EncryptedIntentRequest, IntentAccepted } from "./types.js";

const SAMPLE_REQUEST: EncryptedIntentRequest = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:0xAgentAddress",
  encryptedIntentEnvelope: "t3cipher.sealed.envelope.base64url",
  authorityRef: "t3-delegation:abc",
};

const SAMPLE_RESPONSE: IntentAccepted = {
  intentHandle: "intent_abc123",
  state: "intent_sealed",
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

describe("IntentClient", () => {
  it("POSTs to /api/agents/intents with the bearer token and returns the accepted intent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_RESPONSE));

    const client = new IntentClient("https://api.example.com");
    const result = await client.submitIntent(SAMPLE_REQUEST, "gb_session_xyz");

    expect(result).toEqual(SAMPLE_RESPONSE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? [];
    expect(url).toBe("https://api.example.com/api/agents/intents");
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("POST");
    expect((reqInit.headers as Record<string, string>).Authorization).toBe("Bearer gb_session_xyz");
    expect((reqInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(reqInit.body as string)).toEqual(SAMPLE_REQUEST);
  });

  it("strips a trailing slash from the baseUrl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_RESPONSE));
    const client = new IntentClient("https://api.example.com/");
    await client.submitIntent(SAMPLE_REQUEST, "tok");
    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url] = firstCall ?? [];
    expect(url).toBe("https://api.example.com/api/agents/intents");
  });

  it("throws a GhostBrokerApiError on a 4xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "validation_failed", message: "envelope too short" },
        { status: 400 },
      ),
    );

    const client = new IntentClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.submitIntent(SAMPLE_REQUEST, "tok");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("validation_failed");
  });
});
