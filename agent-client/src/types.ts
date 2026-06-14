export interface AuthSession {
  token: string;
  expiresAt: string;
  institution: {
    id: string;
    displayName: string;
    t3TenantDid: string;
  };
}

export interface AgentAdmission {
  agentDid: string;
  status: "admitted" | "rejected";
  authorityRef: string;
}

export interface AdmitAgentRequest {
  institutionId: string;
  agentDid: string;
  /**
   * One of two authority proof shapes:
   *   - the JCS delegation proof built by
   *     `@ghostbroker/agent-client.DelegationProofBuilder` (the
   *     "production" T3 Smart VC flow), OR
   *   - a serialized boundbuyer-style W3C Verifiable Credential,
   *     supplied via the sibling `delegationCredential` field.
   *
   * Exactly one of `authorityProof` or `delegationCredential` must
   * be present.
   */
  authorityProof: string;
  /**
   * Boundbuyer-style W3C VC for the admit step. The backend runs
   * this through `t3-enclave/src/auth/boundbuyer-delegation.ts`,
   * which is a port of the boundbuyer BUIDL's verifier. The
   * verifier's three modes (sandbox / live / structural) are
   * controlled server-side by the `VC_VERIFY_MODE` env var.
   */
  delegationCredential?: unknown;
}

export interface EncryptedIntentRequest {
  institutionId: string;
  agentDid: string;
  encryptedIntentEnvelope: string;
  authorityRef: string;
  /**
   * Optional plain-text settlement metadata. The backend's intent route
   * accepts this as a sibling of the encrypted envelope — the orchestrator
   * reads `assetCode`/`side`/`quantity`/`price` from this block, and the
   * encrypted envelope carries the TEE-sealed commitment. The
   * `$.settlementMetadata` path is exempt from the forbidden-fields scan
   * (see `backend/src/validation/encrypted-intent.schema.ts`).
   *
   * The agent path that doesn't go through a TEE can pass this directly;
   * production T3-enclave flows will seal the equivalent parameters in
   * the envelope and may leave this block absent.
   */
  settlementMetadata?: {
    assetCode: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
  };
}

export interface IntentAccepted {
  intentHandle: string;
  state: "intent_sealed";
}

export interface CompletedTrade {
  id: string;
  tradeRef: string;
  assetCodeCiphertext?: string;
  quantityCiphertext?: string;
  executionPriceCiphertext?: string;
  settledAt: string;
  settlementStatus: "settled" | "failed" | "reversed";
  receiptIds: string[];
}

export interface AuditReceipt {
  id: string;
  completedTradeId: string;
  receiptCiphertext: string;
  receiptHash: string;
  keyVersion: string;
  t3AttestationRef: string;
}

export interface Institution {
  id: string;
  legalName: string;
  displayName: string;
  status: "pending" | "active" | "suspended" | "closed";
  t3TenantDid: string;
}

export type TelemetryEventType =
  | "telemetry.connection.changed"
  | "telemetry.agent.changed"
  | "telemetry.processing.changed"
  | "telemetry.error.changed";

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
  | "service_unavailable"
  | "intent_expired"
  | "intent_cancelled"
  | "intent_lock_released";

export interface TelemetryEvent {
  eventId: string;
  institutionId: string;
  type: TelemetryEventType;
  phase: TelemetryPhase;
  severity: "info" | "warning" | "error";
  timestamp: string;
  correlationRef?: string;
  agentId?: string;
  receiptRef?: string;
}

export type RedactedErrorCode =
  | "authorization_failed"
  | "validation_failed"
  | "service_unavailable"
  | "not_found";

export type RequestedAction = "agent.admit" | "intent.submit" | "settlement.execute";
