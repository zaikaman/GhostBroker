import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./websocket-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { TelemetryEvent } from "./types.js";

interface WsHandle {
  onopen: null | (() => void);
  onclose: null | (() => void);
  onerror: null | (() => void);
  onmessage: null | ((ev: { data: string }) => void);
  close: ReturnType<typeof vi.fn>;
}

// Module-level mutable state shared by the stub. This avoids any
// closure-capture subtleties with vitest's hoisting.
let lastWs: WsHandle | null = null;
let allInstances: WsHandle[] = [];

function stubWebSocket(): { ctor: ReturnType<typeof vi.fn>; getLast: () => WsHandle } {
  lastWs = null;
  allInstances = [];

  class WsMock implements WsHandle {
    public onopen: WsHandle["onopen"] = null;
    public onclose: WsHandle["onclose"] = null;
    public onerror: WsHandle["onerror"] = null;
    public onmessage: WsHandle["onmessage"] = null;
    public close = vi.fn();
    public constructor(_url: string) {
      lastWs = this;
      allInstances.push(this);
    }
  }

  // Use a `function` declaration (not an arrow) so the mock is constructable.
  const ctor = vi.fn(function mockWebSocket(this: unknown, url: string) {
    return new WsMock(url);
  });
  vi.stubGlobal("WebSocket", ctor as unknown as typeof WebSocket);

  return {
    ctor,
    getLast: () => {
      if (!lastWs) throw new Error("no WebSocket instance created yet");
      return lastWs;
    },
  };
}

function sampleEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventId: "evt_1",
    institutionId: "inst_1",
    type: "telemetry.connection.changed",
    phase: "backend_connected",
    severity: "info",
    timestamp: "2026-06-14T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  lastWs = null;
  allInstances = [];
});

describe("TelemetryClient", () => {
  it("constructs the WebSocket URL with the institution id on connect", () => {
    const { ctor } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    client.connect();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0]![0]).toBe(
      "wss://api.example.com/ws/telemetry?institutionId=inst_1",
    );
  });

  it("converts http(s) baseUrl to ws(s)", () => {
    const { ctor } = stubWebSocket();
    const client = new TelemetryClient("http://localhost:3001", "inst_1");
    client.connect();
    expect(ctor.mock.calls[0]![0]).toBe(
      "ws://localhost:3001/ws/telemetry?institutionId=inst_1",
    );
  });

  it("percent-encodes the institution id", () => {
    const { ctor } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "id with space/slash");
    client.connect();
    expect(ctor.mock.calls[0]![0]).toBe(
      "wss://api.example.com/ws/telemetry?institutionId=id%20with%20space%2Fslash",
    );
  });

  it("setInstitutionId updates the id used on the next connect", () => {
    const { ctor } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "first");
    client.setInstitutionId("second");
    client.connect();
    expect(ctor.mock.calls[0]![0]).toBe(
      "wss://api.example.com/ws/telemetry?institutionId=second",
    );
  });

  it("dispatches inbound messages to onMessage subscribers", () => {
    const { getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const handler = vi.fn();
    client.onMessage(handler);

    client.connect();
    const ws = getLast();
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(sampleEvent()) });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt_1" }));
  });

  it("ignores malformed inbound messages", () => {
    const { getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const handler = vi.fn();
    client.onMessage(handler);

    client.connect();
    const ws = getLast();
    ws.onopen?.();
    ws.onmessage?.({ data: "not json" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the handler", () => {
    const { getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const handler = vi.fn();
    const unsubscribe = client.onMessage(handler);
    unsubscribe();

    client.connect();
    const ws = getLast();
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(sampleEvent()) });

    expect(handler).not.toHaveBeenCalled();
  });

  it("onSettled only fires for settlement_finalized events", () => {
    const { getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const onSettled = vi.fn();
    client.onSettled(onSettled);

    client.connect();
    const ws = getLast();
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify(sampleEvent({ phase: "intent_sealed", correlationRef: "ignored" })),
    });
    expect(onSettled).not.toHaveBeenCalled();

    ws.onmessage?.({
      data: JSON.stringify(
        sampleEvent({ phase: "settlement_finalized", correlationRef: "ref_1" }),
      ),
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith("ref_1");
  });

  it("onError only fires for telemetry.error.changed events", () => {
    const { getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const onError = vi.fn();
    client.onError(onError);

    client.connect();
    const ws = getLast();
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify(
        sampleEvent({ type: "telemetry.connection.changed", phase: "service_unavailable" }),
      ),
    });
    expect(onError).not.toHaveBeenCalled();

    ws.onmessage?.({
      data: JSON.stringify(
        sampleEvent({
          type: "telemetry.error.changed",
          phase: "settlement_failed",
          correlationRef: "ref_2",
        }),
      ),
    });
    expect(onError).toHaveBeenCalledWith("settlement_failed", "ref_2");
  });

  it("emits status changes via onStatusChange (fires immediately with current status)", () => {
    stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    const handler = vi.fn();
    client.onStatusChange(handler);
    expect(handler).toHaveBeenCalledWith("disconnected");
  });

  it("disconnect closes the socket and stops reconnection", () => {
    const { ctor, getLast } = stubWebSocket();
    const client = new TelemetryClient("https://api.example.com", "inst_1");
    client.connect();
    expect(ctor).toHaveBeenCalledTimes(1);

    client.disconnect();
    expect(getLast().close).toHaveBeenCalled();

    // An inbound onclose should NOT trigger a reconnect.
    getLast().onclose?.();
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("a GhostBrokerApiError is an instance of Error (smoke test)", () => {
    const e = new GhostBrokerApiError(401, "authorization_failed", "x");
    expect(e).toBeInstanceOf(Error);
  });
});
