import type { TelemetryEvent, TelemetryPhase } from "./types.js";

export type TelemetryConnectionStatus = "disconnected" | "connecting" | "connected";

export type TelemetryEventHandler = (event: TelemetryEvent) => void;
export type TelemetryStatusHandler = (status: TelemetryConnectionStatus) => void;

/**
 * WebSocket client for GhostBroker telemetry events.
 *
 * Connects to the real-time agent activity stream and dispatches
 * typed events for agent admission, intent processing, and settlement.
 */
export class TelemetryClient {
  private ws: WebSocket | null = null;
  private status: TelemetryConnectionStatus = "disconnected";
  private readonly baseUrl: string;
  private institutionId: string;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isExplicitClosed = false;
  private readonly messageHandlers = new Set<TelemetryEventHandler>();
  private readonly statusHandlers = new Set<TelemetryStatusHandler>();

  public constructor(baseUrl: string, institutionId: string) {
    // Convert http(s) to ws(s) for WebSocket URL
    this.baseUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
    this.institutionId = institutionId;
  }

  /**
   * Set the institution ID used in the telemetry WebSocket query string.
   * Safe to call at any time; the new value applies on the next (re)connect.
   */
  public setInstitutionId(institutionId: string): void {
    this.institutionId = institutionId;
  }

  /**
   * Connect to the telemetry WebSocket.
   */
  public connect(): void {
    if (this.status === "connected" || this.status === "connecting") return;

    this.isExplicitClosed = false;
    this.setStatus("connecting");

    try {
      const wsUrl = `${this.baseUrl.replace(/\/$/, "")}/ws/telemetry?institutionId=${encodeURIComponent(this.institutionId)}`;
      this.ws = new WebSocket(wsUrl);
      this.registerHandlers();
    } catch {
      this.handleDisconnect();
    }
  }

  /**
   * Disconnect from the telemetry WebSocket.
   */
  public disconnect(): void {
    this.isExplicitClosed = true;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  /**
   * Register a handler for telemetry events.
   * Returns an unsubscribe function.
   */
  public onMessage(handler: TelemetryEventHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Register a handler for connection status changes.
   * Returns an unsubscribe function.
   */
  public onStatusChange(handler: TelemetryStatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  /**
   * Convenience: register a handler for settlement events.
   */
  public onSettled(handler: (correlationRef: string) => void): () => void {
    return this.onMessage((event) => {
      if (event.phase === "settlement_finalized") {
        handler(event.correlationRef ?? "");
      }
    });
  }

  /**
   * Convenience: register a handler for error events.
   */
  public onError(
    handler: (phase: TelemetryPhase, correlationRef: string) => void,
  ): () => void {
    return this.onMessage((event) => {
      if (event.type === "telemetry.error.changed") {
        handler(event.phase, event.correlationRef ?? "");
      }
    });
  }

  private registerHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.clearReconnectTimer();
    };

    this.ws.onmessage = (event) => {
      try {
        const telemetry = JSON.parse(event.data as string) as TelemetryEvent;
        this.messageHandlers.forEach((handler) => handler(telemetry));
      } catch {
        // Ignore malformed events
      }
    };

    this.ws.onclose = () => this.handleDisconnect();
    this.ws.onerror = () => this.handleDisconnect();
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.setStatus("disconnected");

    if (!this.isExplicitClosed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: TelemetryConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.statusHandlers.forEach((handler) => handler(status));
    }
  }
}
