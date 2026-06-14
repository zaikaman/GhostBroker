import "@testing-library/jest-dom/vitest";

interface WebSocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

class MockWebSocket {
  public url: string;
  public readyState = 0; // CONNECTING
  public onopen: (() => void) | null = null;
  public onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Simulate async connection success
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) {
        this.onopen();
      }
    }, 10);
  }

  public send(_data: string): void {
    // No-op: tests don't exercise send, but the WebSocket interface
    // requires the method to exist.
  }
  public close(): void {
    this.readyState = 3; // CLOSED
    if (this.onclose) {
      this.onclose({ code: 1000, reason: 'Normal closure', wasClean: true });
    }
  }
}

global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

