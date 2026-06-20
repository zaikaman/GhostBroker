import { WS_TELEMETRY_URL } from './env.js';

export type TelemetryEventType =
  | 'telemetry.connection.changed'
  | 'telemetry.agent.changed'
  | 'telemetry.processing.changed'
  | 'telemetry.error.changed'
  | 'telemetry.portfolio.changed';

export type TelemetryPhase =
  | 'backend_connected'
  | 'websocket_connected'
  | 'supabase_connected'
  | 't3_sandbox_connected'
  | 'agent_connected'
  | 'agent_disconnected'
  | 'agent_verifying'
  | 'agent_verified'
  | 'agent_rejected'
  | 'authority_revoked'
  | 'intent_received'
  | 'intent_sealed'
  | 'encrypted_evaluation'
  | 'settlement_pending'
  | 'settlement_finalized'
  | 'portfolio_updated'
  | 'receipt_available'
  | 'authorization_failed'
  | 'token_metering_failed'
  | 'settlement_failed'
  | 'service_unavailable'
  | 'intent_expired'
  | 'negotiation_ticket_sealed'
  | 'negotiation_paired'
  | 'negotiation_round_open'
  | 'negotiation_move_submitted'
  | 'negotiation_disclosure_verified'
  | 'negotiation_converged'
  | 'negotiation_walked_away'
  | 'negotiation_expired'
  | 'negotiation_settling'
  | 'negotiation_settled';

export interface TelemetryEvent {
  eventId: string;
  institutionId: string;
  type: TelemetryEventType;
  phase: TelemetryPhase;
  severity: 'info' | 'warning' | 'error';
  timestamp: string;
  correlationRef?: string;
  agentId?: string;
  receiptRef?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

type MessageListener = (event: TelemetryEvent) => void;
type StatusListener = (status: ConnectionStatus) => void;

// List of forbidden keys that should NEVER be present in any received event.
const FORBIDDEN_KEYS = [
  'asset',
  'side',
  'quantity',
  'bid',
  'ask',
  'price',
  'count',
  'rank',
  'depth',
  'counterparty',
  'arguments',
  'plaintext',
  'secret',
];

export class TelemetryClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private url: string;
  private token: string | null = null;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  
  // Reconnect policy configurations
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30s
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isExplicitClosed = false;

  constructor() {
    this.url = WS_TELEMETRY_URL;
  }

  public connect(token?: string): void {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }
    
    this.isExplicitClosed = false;
    this.token = token || null;
    this.updateStatus('connecting');

    try {
      // Derive the institution ID from localStorage (same source as REST API headers),
      // falling back to the explicit token or the demo default.
      const institutionId =
        this.token ??
        localStorage.getItem('x-operator-institution-id') ??
        '00000000-0000-4000-8000-000000000301';

      const socketUrl = `${this.url}?institutionId=${encodeURIComponent(institutionId)}`;
      this.ws = new WebSocket(socketUrl);
      this.registerSocketEvents();
    } catch (error) {
      console.error('[TelemetryClient] Connection initialization failed:', error);
      this.handleDisconnect();
    }
  }

  public disconnect(): void {
    this.isExplicitClosed = true;
    this.clearReconnectTimer();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.updateStatus('disconnected');
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    // Emit current state immediately
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private registerSocketEvents(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      console.log('[TelemetryClient] Secure WebSocket channel opened.');
      this.updateStatus('connected');
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
    };

    this.ws.onmessage = (event) => {
      try {
        const rawData = JSON.parse(event.data as string) as Record<string, unknown>;
        
        // Strict runtime validation for forbidden fields
        if (this.containsForbiddenFields(rawData)) {
          console.error('[TelemetryClient] Security Violations Detected: Redacted forbidden parameters from telemetry payload. Event dropped.');
          return;
        }

        // Validate the structure aligns with TelemetryEvent
        if (this.isValidTelemetryEvent(rawData)) {
          this.notifyMessageListeners(rawData);
        } else {
          console.warn('[TelemetryClient] Received invalid telemetry event structure:', rawData);
        }
      } catch (err) {
        console.error('[TelemetryClient] Failed to process telemetry message:', err);
      }
    };

    this.ws.onclose = (event) => {
      if (this.isExplicitClosed) {
        console.debug('[TelemetryClient] WebSocket disconnected (cleanup).');
      } else {
        console.log(`[TelemetryClient] WebSocket connection closed: code=${event.code}, reason=${event.reason}`);
      }
      this.handleDisconnect();
    };

    this.ws.onerror = (err) => {
      if (this.isExplicitClosed) {
        // StrictMode double-mount: connection was torn down before it established
        console.debug('[TelemetryClient] WebSocket connection interrupted during cleanup.');
        return;
      }
      console.warn('[TelemetryClient] WebSocket connection failed. Reconnecting with exponential backoff...', err);
      // Let onclose handle the recovery policy
    };
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.updateStatus('disconnected');
    
    if (!this.isExplicitClosed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    
    console.log(`[TelemetryClient] Scheduling reconnection in ${delay}ms (Attempt #${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.token || undefined);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private updateStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.statusListeners.forEach((listener) => listener(newStatus));
    }
  }

  private notifyMessageListeners(event: TelemetryEvent): void {
    this.messageListeners.forEach((listener) => listener(event));
  }

  private containsForbiddenFields(obj: Record<string, unknown>): boolean {
    const keys = Object.keys(obj);
    
    // Check keys of current level
    const hasForbiddenKey = keys.some((key) => {
      const normalizedKey = key.toLowerCase();
      return FORBIDDEN_KEYS.some((forbidden) => normalizedKey.includes(forbidden));
    });

    if (hasForbiddenKey) {
      return true;
    }

    // Deep check nested objects
    for (const key of keys) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        if (this.containsForbiddenFields(val as Record<string, unknown>)) {
          return true;
        }
      }
    }

    return false;
  }

  private isValidTelemetryEvent(obj: unknown): obj is TelemetryEvent {
    if (!obj || typeof obj !== 'object') return false;
    const o = obj as Record<string, unknown>;
    return (
      typeof o.eventId === 'string' &&
      typeof o.institutionId === 'string' &&
      (o.type === 'telemetry.connection.changed' ||
        o.type === 'telemetry.agent.changed' ||
        o.type === 'telemetry.processing.changed' ||
        o.type === 'telemetry.error.changed' ||
        o.type === 'telemetry.portfolio.changed') &&
      typeof o.phase === 'string' &&
      (o.severity === 'info' || o.severity === 'warning' || o.severity === 'error') &&
      typeof o.timestamp === 'string'
    );
  }
}

export const telemetryClient = new TelemetryClient();
