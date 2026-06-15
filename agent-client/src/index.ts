export { AuthClient, type AuthClientConfig } from "./auth-client.js";
export { IntentClient } from "./intent-client.js";
export { TradesClient } from "./trades-client.js";
export { ReceiptClient } from "./receipt-client.js";
export {
  PortfolioClient,
  type AgentPortfolioRequest,
} from "./portfolio-client.js";
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
  AgentPortfolio,
  PortfolioHolding,
  PendingReservation,
  TelemetryEvent,
  RedactedErrorCode,
  Institution,
} from "./types.js";
export { GhostBrokerApiError } from "./errors.js";

/**
 * Browser-safe W3C VC delegation signing. Pure functions — no
 * Node-only modules — so the dashboard can mint and sign an
 * agent's delegation credential in the browser (no CLI
 * required) and the agent process / `setup:delegation`
 * operator tool can both produce VCs that the backend's
 * `@terminal3/verify_vc`-backed verifier accepts.
 */
export {
  buildDelegationSigningBody,
  canonicalizeDelegationJson,
  delegationCredentialSchema,
  mintAndSignDelegationCredential,
  mintDelegationCredentialBody,
  signDelegationCredential,
  type DelegationCredential,
  type DelegationSigningBody,
  type MintAndSignDelegationOptions,
  type MintDelegationCredentialBody,
  type SignDelegationCredentialOptions,
} from "./delegation-signer.js";
