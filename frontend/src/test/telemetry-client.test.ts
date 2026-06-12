import { TelemetryClient } from '../services/telemetry-client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

let currentWs: TestWebSocket | null = null;
const closeSpy = vi.fn();
const sendSpy = vi.fn();

class TestWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    currentWs = this;
  }

  close() {
    closeSpy();
  }

  send(data: string) {
    sendSpy(data);
  }
}

describe('TelemetryClient Class', () => {
  let client: TelemetryClient;
  const originalWebSocket = global.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    currentWs = null;
    closeSpy.mockClear();
    sendSpy.mockClear();
    global.WebSocket = TestWebSocket as any;
    client = new TelemetryClient();
  });

  afterEach(() => {
    client.disconnect();
    global.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('receives and notifies listeners of valid, clean telemetry events', () => {
    client.connect();
    expect(client.getStatus()).toBe('connecting');

    // Trigger open
    if (currentWs?.onopen) {
      currentWs.onopen();
    }
    expect(client.getStatus()).toBe('connected');

    // Setup listener
    const listener = vi.fn();
    client.onMessage(listener);

    // Trigger clean message
    const cleanEvent = {
      eventId: 'evt_1',
      institutionId: 'inst_1',
      type: 'telemetry.processing.changed',
      phase: 'intent_sealed',
      severity: 'info',
      timestamp: '2026-06-12T00:00:00Z',
      correlationRef: 'corr_1',
    };

    if (currentWs?.onmessage) {
      currentWs.onmessage({
        data: JSON.stringify(cleanEvent),
      });
    }

    expect(listener).toHaveBeenCalledWith(cleanEvent);
  });

  it('drops incoming telemetry events containing forbidden fields (redaction guardrail)', () => {
    client.connect();
    if (currentWs?.onopen) {
      currentWs.onopen();
    }

    const listener = vi.fn();
    client.onMessage(listener);

    // 1. Trigger forbidden key in top-level
    const badEventTop = {
      eventId: 'evt_2',
      institutionId: 'inst_1',
      type: 'telemetry.processing.changed',
      phase: 'intent_sealed',
      severity: 'info',
      timestamp: '2026-06-12T00:00:00Z',
      price: '50000', // Forbidden
    };

    if (currentWs?.onmessage) {
      currentWs.onmessage({
        data: JSON.stringify(badEventTop),
      });
    }

    expect(listener).not.toHaveBeenCalled();

    // 2. Trigger forbidden key in nested object
    const badEventNested = {
      eventId: 'evt_3',
      institutionId: 'inst_1',
      type: 'telemetry.processing.changed',
      phase: 'intent_sealed',
      severity: 'info',
      timestamp: '2026-06-12T00:00:00Z',
      details: {
        asset: 'BTC-USD', // Forbidden
      },
    };

    if (currentWs?.onmessage) {
      currentWs.onmessage({
        data: JSON.stringify(badEventNested),
      });
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it('implements exponential backoff reconnect logic upon websocket closure', () => {
    let callCount = 0;
    
    // Override the constructor to count instances
    class TrackedWebSocket extends TestWebSocket {
      constructor(url: string) {
        super(url);
        callCount++;
      }
    }
    global.WebSocket = TrackedWebSocket as any;

    // First connection
    client.connect();
    if (currentWs?.onopen) {
      currentWs.onopen();
    }
    expect(client.getStatus()).toBe('connected');

    // Connection closes (not explicitly by client)
    if (currentWs?.onclose) {
      currentWs.onclose({ code: 1006, reason: 'Abnormal Closure' });
    }
    expect(client.getStatus()).toBe('disconnected');

    // Reconnection #1 should be scheduled with 1000ms delay (2^0 * 1000)
    expect(callCount).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(2);

    // Open connection #2
    if (currentWs?.onopen) {
      currentWs.onopen();
    }
    expect(client.getStatus()).toBe('connected');

    // Connection closes again
    if (currentWs?.onclose) {
      currentWs.onclose({ code: 1006, reason: 'Abnormal Closure' });
    }

    // Reconnection #2 should be scheduled (since reconnectAttempts was reset on successful open to 0, next is 1000ms)
    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(3);
  });
});
