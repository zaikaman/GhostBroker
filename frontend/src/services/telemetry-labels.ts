import type { TelemetryPhase } from './telemetry-client';

export interface TelemetryLabelInfo {
  label: string;
  description: string;
  statusType: 'success' | 'warning' | 'error' | 'info';
}

const PHASE_LABELS: Record<TelemetryPhase, TelemetryLabelInfo> = {
  backend_connected: {
    label: 'API Gateway Connected',
    description: 'Secure connection established to backend servers.',
    statusType: 'success',
  },
  websocket_connected: {
    label: 'Telemetry Stream Online',
    description: 'Real-time cryptographic telemetry channel opened.',
    statusType: 'success',
  },
  supabase_connected: {
    label: 'Data Storage Initialized',
    description: 'Secure link to encrypted database verified.',
    statusType: 'success',
  },
  t3_sandbox_connected: {
    label: 'T3 Sandbox Operational',
    description: 'Smart contract broker connection established.',
    statusType: 'success',
  },
  agent_connected: {
    label: 'Agent Handshake Initiated',
    description: 'An external agent has connected to the enclave.',
    statusType: 'info',
  },
  agent_disconnected: {
    label: 'Agent Session Terminated',
    description: 'The agent has disconnected from the secure enclave.',
    statusType: 'info',
  },
  agent_verifying: {
    label: 'Verifying Authority',
    description: 'Enclave is validating agent DID and cryptographic delegation grant.',
    statusType: 'warning',
  },
  agent_verified: {
    label: 'Agent Session Admitted',
    description: 'Agent identity and scope verified. Secure execution admitted.',
    statusType: 'success',
  },
  agent_rejected: {
    label: 'Agent Admission Denied',
    description: 'Enclave rejected the agent: invalid signature or verification failure.',
    statusType: 'error',
  },
  authority_revoked: {
    label: 'Authority Revoked',
    description: 'The delegation grant has been revoked. Session terminated.',
    statusType: 'error',
  },
  intent_received: {
    label: 'Intent Sealed',
    description: 'Encrypted envelope received. Plaintext parameters obscured.',
    statusType: 'warning',
  },
  intent_sealed: {
    label: 'Payload Blinded',
    description: 'Intent parameters blinded inside enclave. Handle registered.',
    statusType: 'warning',
  },
  encrypted_evaluation: {
    label: 'Private Evaluation',
    description: 'Hardware-secured matching engine evaluating execution criteria.',
    statusType: 'warning',
  },
  settlement_pending: {
    label: 'Settlement Initiated',
    description: 'Executing atomic trade settlement instructions on ledger.',
    statusType: 'warning',
  },
  settlement_finalized: {
    label: 'Settlement Finalized',
    description: 'Atomic transfer complete. Token balances updated.',
    statusType: 'success',
  },
  portfolio_updated: {
    label: 'Portfolio Updated',
    description: 'Portfolio balances refreshed after settlement execution.',
    statusType: 'info',
  },
  receipt_available: {
    label: 'Audit Receipt Generated',
    description: 'Verifiable cryptographic receipt issued by secure enclave.',
    statusType: 'success',
  },
  authorization_failed: {
    label: 'Authorization Failed',
    description: 'Secure enclave denied request authorization.',
    statusType: 'error',
  },
  token_metering_failed: {
    label: 'Metering Depleted',
    description: 'Execution stopped: T3 transaction tokens depleted.',
    statusType: 'error',
  },
  settlement_failed: {
    label: 'Settlement Aborted',
    description: 'Atomic transaction aborted. Vault balances rolled back.',
    statusType: 'error',
  },
  service_unavailable: {
    label: 'Enclave Unreachable',
    description: 'The secure hardware enclave is currently offline.',
    statusType: 'error',
  },
  intent_expired: {
    label: 'Intent Expired',
    description: 'Unmatched intent TTL exceeded. Removed from pending queue without execution.',
    statusType: 'warning',
  },
};

/**
 * Resolves a TelemetryPhase into a human-readable display label and metadata.
 */
export function getTelemetryLabel(phase: TelemetryPhase): TelemetryLabelInfo {
  return PHASE_LABELS[phase] || {
    label: phase.replace(/_/g, ' ').toUpperCase(),
    description: 'System telemetry state update.',
    statusType: 'info',
  };
}
