export { AuthClient, type AuthClientConfig } from "./auth-client.js";
export {
  DelegationProofBuilder,
  type DelegationProofOptions,
  type SignedDelegationProof,
} from "./delegation-proof.js";
export { IntentClient } from "./intent-client.js";
export { TradesClient } from "./trades-client.js";
export { ReceiptClient } from "./receipt-client.js";
export { TelemetryClient } from "./websocket-client.js";
export {
  GhostBrokerClient,
  type GhostBrokerClientConfig,
} from "./ghostbroker-client.js";
export type {
  AuthSession,
  AgentAdmission,
  IntentAccepted,
  CompletedTrade,
  AuditReceipt,
  TelemetryEvent,
  RedactedErrorCode,
  Institution,
} from "./types.js";
export { GhostBrokerApiError } from "./errors.js";
