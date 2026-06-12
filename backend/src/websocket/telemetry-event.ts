export type TelemetryEventType =
  | "telemetry.connection.changed"
  | "telemetry.agent.changed"
  | "telemetry.processing.changed"
  | "telemetry.error.changed";

export type TelemetrySeverity = "info" | "warning" | "error";

export type TelemetryPhase =
  | "backend_connected"
  | "websocket_connected"
  | "supabase_connected"
  | "t3_sandbox_connected"
  | "agent_connected"
  | "agent_disconnected"
  | "agent_verifying"
  | "agent_verified"
  | "agent_rejected"
  | "authority_revoked"
  | "intent_received"
  | "intent_sealed"
  | "encrypted_evaluation"
  | "settlement_pending"
  | "settlement_finalized"
  | "receipt_available"
  | "authorization_failed"
  | "token_metering_failed"
  | "settlement_failed"
  | "service_unavailable";

export interface TelemetryEvent {
  eventId: string;
  institutionId: string;
  type: TelemetryEventType;
  phase: TelemetryPhase;
  severity: TelemetrySeverity;
  timestamp: string;
  correlationRef: string;
  agentId?: string;
  receiptRef?: string;
}

export type TelemetryEventInput = Omit<TelemetryEvent, "timestamp"> & {
  timestamp?: string;
};
