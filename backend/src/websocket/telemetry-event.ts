export type TelemetryEventType =
  | "telemetry.connection.changed"
  | "telemetry.agent.changed"
  | "telemetry.processing.changed"
  | "telemetry.error.changed"
  | "telemetry.portfolio.changed";

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
  | "rail_settled"
  | "rail_reconciled"
  | "rail_drift_detected"
  | "rail_reconcile_error"
  | "rail_reversed"
  | "portfolio_updated"
  | "receipt_available"
  | "authorization_failed"
  | "token_metering_failed"
  | "settlement_failed"
  | "service_unavailable"
  | "intent_expired"
  | "intent_cancelled"
  | "intent_lock_released"
  | "negotiation_ticket_sealed"
  | "negotiation_paired"
  | "negotiation_round_open"
  | "negotiation_move_submitted"
  | "negotiation_disclosure_verified"
  | "negotiation_disclosure_required"
  | "negotiation_held"
  | "negotiation_escalation_requested"
  | "negotiation_escalation_approved"
  | "negotiation_escalation_declined"
  | "negotiation_escalation_expired"
  | "negotiation_converged"
  | "negotiation_walked_away"
  | "negotiation_expired"
  | "negotiation_settling"
  | "negotiation_settled";

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
  /**
   * WS1: rail transport proof. Set on `rail_settled` events. Holds
   * only the rail id and the rail-specific transport ref (a chain
   * tx hash for the chain rail, a custody ref for the custody rail,
   * a `noop:<sha256>` for the noop rail). The proof is intentionally
   * NOT included because the proof's `assetMovements` array would
   * surface on the operator websocket, which violates the
   * `telemetry-settlement-redaction.test.ts` invariant that no
   * settlement-phase payload contain plaintext asset/quantity/price
   * substrings.
   */
  railProofRef?: { railId: string; railTradeRef: string };
  /**
   * WS4: rail dispatch latency in milliseconds. Set on
   * `rail_settled` events so ops can graph p50 / p99 rail
   * dispatch latency per rail. The value is the wall-clock
   * time the rail's `dispatch` call took (from `T0 = we
   * start the dispatch` to `T1 = proof returned`).
   */
  latencyMs?: number;
}

export type TelemetryEventInput = Omit<TelemetryEvent, "eventId" | "timestamp"> & {
  eventId?: string;
  timestamp?: string;
};
