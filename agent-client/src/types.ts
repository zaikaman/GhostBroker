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
   * The W3C Verifiable Credential that authorizes this
   * agent to act on behalf of the institution.
   *
   * Post-Phase 1: the delegation VC is owned by the
   * backend. The dashboard mints + signs it on the
   * "Configure Agent" form and persists it on the agent
   * record; the agent process never holds or sends the
   * VC. The backend's `loadAndVerify` facade looks the VC
   * up on every privileged call and runs the existing
   * verifier against it.
   *
   * The optional field is kept here for forward-compat:
   * a custom integration that wants to send the VC inline
   * (e.g. an E2E test, or a legacy agent that hasn't
   * migrated yet) can still do so. When supplied, the
   * backend's admit path runs the verifier on the inline
   * VC instead of the persisted one.
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

/**
 * A single holding in the institution's portfolio. `balance` is the
 * current `portfolios.balance` column; `locked` is the current
 * `portfolios.locked` column. The available balance for trading is
 * `balance - locked` — that is what the agent should size intents
 * against. The orchestrator's balance-lock check is the real
 * authority on whether a submit will succeed, so an agent that
 * reads these values is informational, not authoritative.
 */
export interface PortfolioHolding {
  assetCode: string;
  balance: number;
  locked: number;
}

/**
 * A reservation currently held against a single pending intent.
 * Mirrors the orchestrator's `lockDescriptorFor` calculation:
 *  - buy intent → reserves `quantity * price` units of the
 *    settlement asset (USDC by default),
 *  - sell intent → reserves `quantity` units of the traded asset.
 *
 * Subtracting `amount` from the matching holding's available
 * balance yields the institution's free balance for new intents.
 */
export interface PendingReservation {
  intentHandle: string;
  assetCode: string;
  amount: number;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

/**
 * The agent-level portfolio view, returned by
 * `PortfolioClient.getPortfolio(...)`. The view is institution-
 * scoped and (when `agentDid` is supplied) filtered to a single
 * agent's pending reservations.
 */
export interface AgentPortfolio {
  institutionId: string;
  agentDid: string;
  holdings: PortfolioHolding[];
  pendingReservations: PendingReservation[];
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
