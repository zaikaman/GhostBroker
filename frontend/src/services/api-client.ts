export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  services: Record<string, 'ok' | 'degraded' | 'unavailable'>;
}

export interface CreateInstitutionRequest {
  legalName: string;
  displayName: string;
  settlementProfileRef: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateInstitutionRequest {
  settlementProfileRef?: string;
  metadata?: Record<string, unknown>;
}

export interface RelayerApprovalResponse {
  depositAddress: string;
  relayerContractAddress: string;
  txHashes: {
    wbtcApprove?: string;
    usdcApprove?: string;
  };
  balances: {
    eth: string;
    wbtc: string;
    usdc: string;
  };
  approved: {
    wbtc: boolean;
    usdc: boolean;
  };
}

export type WithdrawalAsset = 'ETH' | 'WBTC' | 'USDC';

export interface WithdrawRequest {
  asset: WithdrawalAsset;
  amount: string;
  toAddress: string;
}

export interface WithdrawResponse {
  asset: WithdrawalAsset;
  amount: string;
  fromAddress: string;
  toAddress: string;
  txHash: string;
  remainingBalance: string;
}

export interface Institution {
  id: string;
  legalName: string;
  displayName: string;
  status: 'pending' | 'active' | 'suspended' | 'closed';
  t3TenantDid: string;
  settlementProfileRef: string;
  metadata?: Record<string, unknown>;
}

export interface AdmitAgentRequest {
  institutionId: string;
  agentDid: string;
  delegationCredential?: unknown;
}

export interface Agent {
  id: string;
  institutionId: string;
  agentDid: string;
  status: 'admitted' | 'revoked';
  authorityRef: string;
  label: string | null;
  instrumentScope: string[] | null;
  directionScope: string[] | null;
  maxNotional: string | null;
  limitReference: string | null;
  policyHash: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisionAgentPolicy {
  maxSpendUsd: number;
  allowedCategories: ('office-supplies' | 'software' | 'hardware' | 'services' | 'travel')[];
  approverEmail?: string;
  purpose?: string;
  validityMonths?: number;
}

export interface ProvisionAgentRequest {
  institutionId: string;
  label?: string;
  /**
   * The dashboard-minted secp256k1-derived DID the agent will use
   * (`did:t3n:0x<eth-address>`). The dashboard holds the matching
   * private keypair in memory; only the public DID crosses the wire
   * and the backend's tenant signer binds the delegation VC to it.
   * Required — the backend rejects configuration requests that
   * omit it.
   */
  agentDid: string;
  policy: ProvisionAgentPolicy;
}

export interface AgentAdmission {
  id?: string;
  agentDid: string;
  status: 'admitted' | 'rejected';
  authorityRef: string;
}

export interface ProvisionAgentResponse {
  agent: Agent;
  admission: {
    id?: string;
    agentDid: string;
    status: 'admitted';
    authorityRef: string;
  };
  policyHash: string;
}

export interface AuthChallenge {
  challengeId: string;
  challenge: string;
  expiresAt: string;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  institution: {
    id: string;
    displayName: string;
    t3TenantDid: string;
  };
}

export interface EncryptedIntentRequest {
  institutionId: string;
  agentDid: string;
  encryptedIntentEnvelope: string;
  authorityRef: string;
}

export interface IntentAccepted {
  intentHandle: string;
  state: 'intent_sealed';
}

export interface CompletedTrade {
  id: string;
  tradeRef: string;
  assetCodeCiphertext?: string;
  quantityCiphertext?: string;
  executionPriceCiphertext?: string;
  settledAt: string;
  settlementStatus: 'settled' | 'failed' | 'reversed';
  receiptIds: string[];
  railId: string | null;
  railTradeRef: string | null;
  railState: 'settled' | 'failed' | 'reversed' | null;
}

export interface PortfolioHolding {
  assetCode: string;
  balance: number;
  locked: number;
}

export interface Portfolio {
  institutionId: string;
  holdings: PortfolioHolding[];
}

export interface PortfolioHistoryEntry {
  id: string;
  institutionId: string;
  assetCode: string;
  delta: number;
  balanceAfter: number;
  changeType: 'settlement_buy' | 'settlement_sell' | 'adjustment' | 'import';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

export interface AuditReceipt {
  id: string;
  completedTradeId: string;
  receiptCiphertext: string;
  receiptHash: string;
  keyVersion: string;
  t3AttestationRef: string;
}

export interface HostedAgentConfig {
  mandateId: string;
  pollIntervalMs: number;
  maxTicks: number;
  dryRun: boolean;
}

export interface HostedAgentRuntimeStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number;
  lastSignal?: string;
  sessionExpiresAt?: string;
  lastError?: string;
  logTail: string;
}

export interface NegotiationMandateSummary {
  id: string;
  assetCode: string;
  side: 'buy' | 'sell';
  targetQuantity: string;
  referencePrice: string;
  priceBandBps: number;
  maxNotional: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  deadline: string;
  disclosableClaims: string[];
  requiredCounterpartyClaims: Record<string, unknown>;
  counterpartyConstraints: Record<string, unknown>;
  operatorPrompt: string;
  policyHash: string;
  createdAt: string;
  updatedAt: string;
  // Authored AI-first policy summary (nullable for legacy mandates).
  objective: string | null;
  executionStyle: NegotiationExecutionStyle | null;
  valuationPolicy: Record<string, unknown> | null;
  concessionPolicy: Record<string, unknown> | null;
  disclosurePolicy: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown> | null;
  counterpartyRequirements: Record<string, unknown> | null;
  sizePolicy: Record<string, unknown> | null;
  timeWindow: Record<string, unknown> | null;
  operatorInstructions: string | null;
  minimumQuantity: string | null;
  partialExecutionAllowed: boolean | null;
  derivedAnchorValue: string | null;
  derivedWalkawayMin: string | null;
  derivedWalkawayMax: string | null;
  derivedConcessionBudgetBps: number | null;
  derivedNotionalCeiling: string | null;
}

export interface HostedAgentRecord {
  agent: Agent;
  config: HostedAgentConfig | null;
  runtime: HostedAgentRuntimeStatus;
  mandate: NegotiationMandateSummary | null;
  migrationState: 'ready' | 'needs_migration';
}

export interface CreateHostedAgentRequest {
  institutionId: string;
  agentId: string;
  config: HostedAgentConfig;
  startOnCreate?: boolean;
}

export type RedactedErrorCode =
  | 'authorization_failed'
  | 'validation_failed'
  | 'service_unavailable'
  | 'not_found';

export interface RedactedError {
  code: RedactedErrorCode;
  message: string;
}

export class ApiClientError extends Error {
  status: number;
  code: RedactedErrorCode | 'request_failed';

  constructor(status: number, code: RedactedErrorCode | 'request_failed', message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const AUTH_TOKEN_KEY = 'ghostbroker-auth-token';
const AUTH_SESSION_KEY = 'ghostbroker-auth-session';

const getOperatorHeaders = (): Record<string, string> => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
};

function buildOperatorRequestInit(init: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, init.headers);
    }
  }
  headers.Accept = headers.Accept ?? 'application/json';
  for (const [key, value] of Object.entries(getOperatorHeaders())) {
    headers[key] = value;
  }
  return { ...init, headers };
}

async function requestWithOperatorFallback(input: string, init: RequestInit = {}): Promise<Response> {
  const performFetch = () => fetch(input, buildOperatorRequestInit(init));
  let response = await performFetch();
  if (response.status === 401 && localStorage.getItem(AUTH_TOKEN_KEY)) {
    apiClient.clearAuthSession();
    response = await performFetch();
  }
  return response;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorCode: RedactedErrorCode | 'request_failed' = 'request_failed';
    let errorMessage = `HTTP error! Status: ${response.status}`;
    try {
      const errorData = await response.json() as Partial<RedactedError>;
      if (errorData && typeof errorData.code === 'string') {
        errorCode = errorData.code as RedactedErrorCode;
      }
      if (errorData && typeof errorData.message === 'string') {
        errorMessage = errorData.message;
      }
    } catch {
      if (response.status === 403) {
        errorCode = 'authorization_failed';
        errorMessage = 'Authorization failed. Request rejected by the security enclave.';
      } else if (response.status === 404) {
        errorCode = 'not_found';
        errorMessage = 'Requested resource was not found.';
      } else if (response.status >= 500) {
        errorCode = 'service_unavailable';
        errorMessage = 'The secure enclave services are temporarily unavailable.';
      }
    }
    throw new ApiClientError(response.status, errorCode, errorMessage);
  }
  return response.json() as Promise<T>;
}

export type NegotiationEscalationStatus =
  | 'none'
  | 'pending'
  | 'approved'
  | 'declined';

export interface NegotiationSession {
  id: string;
  assetCode: string;
  status: 'pairing' | 'active' | 'awaiting_approval' | 'converged' | 'settling' | 'settled' | 'walked_away' | 'expired';
  currentTurn: 'buy' | 'sell';
  roundNumber: number;
  maxRounds: number;
  deadline: string;
  tradeRef: string | null;
  distanceSignal: 'crossed' | 'near' | 'moderate' | 'far' | null;
  counterpartStandingProposal: { price: number | null; quantity: number | null };
  trustLevel: 'none' | 'partial' | 'established';
  disclosureProgress: {
    requiredClaims: string[];
    receivedVerifiedClaims: string[];
    pendingRequiredClaims: string[];
  };
  escalationStatus: NegotiationEscalationStatus;
  escalationPending: boolean;
  escalationReason: string | null;
  latestStrategySignal: string | null;
  disclosedClaims: { id: string; fromSide: string; claimType: string; verified: boolean; createdAt: string }[];
  rounds: {
    id: string;
    roundNumber: number;
    actorSide: string;
    moveType: string;
    disclosedClaimRefs?: string[];
    opaqueSignal: string | null;
    reasoning: string | null;
    strategicIntent: string | null;
    confidence: number | null;
    escalationRequested: boolean | null;
    settlementReadiness: string | null;
    createdAt: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Authored AI-first policy mandate (the operator-facing surface)
// ---------------------------------------------------------------------------

export type NegotiationExecutionStyle =
  | 'patient'
  | 'balanced'
  | 'aggressive'
  | 'relationship_first'
  | 'trust_first';

export type NegotiationValuationSource = 'auto_anchor' | 'internal_fair_value' | 'operator_note';

export interface AuthoredValuationPolicy {
  source: NegotiationValuationSource;
  anchorValue?: number;
  note?: string;
}

export interface AuthoredConcessionPolicy {
  pace: 'patient' | 'balanced' | 'aggressive';
  maxConcessionBps: number;
}

export interface AuthoredDisclosurePolicy {
  allowLadder: string[];
  requireReciprocityFor?: string[];
}

export interface AuthoredApprovalPolicy {
  mode: 'auto_settle' | 'escalate_outside_envelope';
  preferredEnvelopeNote?: string;
}

export interface AuthoredSizePolicy {
  targetQuantity: number;
  minimumQuantity: number;
  partialExecutionAllowed: boolean;
}

export interface AuthoredTimeWindow {
  deadline: string;
  preferredWindowStart?: string;
  preferredWindowEnd?: string;
}

export interface AuthoredCounterpartyRequirements {
  requiredClaims: string[];
  disallowedTraits: string[];
  reputationTier?: string;
}

export interface AuthoredMandatePolicy {
  objective: string;
  assetCode: string;
  side: 'buy' | 'sell';
  sizePolicy: AuthoredSizePolicy;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  executionStyle: NegotiationExecutionStyle;
  valuationPolicy: AuthoredValuationPolicy;
  concessionPolicy: AuthoredConcessionPolicy;
  disclosurePolicy: AuthoredDisclosurePolicy;
  counterpartyRequirements: AuthoredCounterpartyRequirements;
  approvalPolicy: AuthoredApprovalPolicy;
  timeWindow: AuthoredTimeWindow;
  operatorInstructions: string;
}

export interface CreateNegotiationMandateRequest {
  authored: AuthoredMandatePolicy;
}

export const apiClient = {
  setAuthSession(session: AuthSession): void {
    localStorage.setItem(AUTH_TOKEN_KEY, session.token);
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    localStorage.setItem('x-operator-institution-id', session.institution.id);
    localStorage.setItem('x-operator-id', `did:${session.institution.t3TenantDid}`);
  },

  clearAuthSession(): void {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_SESSION_KEY);
  },

  getAuthSession(): AuthSession | null {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (raw) {
      try {
        const session = JSON.parse(raw) as AuthSession;
        if (new Date(session.expiresAt).getTime() <= Date.now()) {
          this.clearAuthSession();
        } else {
          return session;
        }
      } catch {
        this.clearAuthSession();
      }
    }
    return null;
  },

  setOperatorContext(institutionId: string, operatorId?: string): void {
    localStorage.setItem('x-operator-institution-id', institutionId);
    if (operatorId) {
      localStorage.setItem('x-operator-id', operatorId);
    } else {
      localStorage.removeItem('x-operator-id');
    }
  },

  getOperatorContext(): { institutionId: string; operatorId: string } {
    return {
      institutionId: localStorage.getItem('x-operator-institution-id') || '00000000-0000-4000-8000-000000000301',
      operatorId: localStorage.getItem('x-operator-id') || 'operator:unattributed',
    };
  },

  async getHealth(): Promise<HealthResponse> {
    const res = await fetch(`${API_BASE_URL}/api/health`, {
      headers: { Accept: 'application/json' },
    });
    return handleResponse<HealthResponse>(res);
  },

  async createInstitution(req: CreateInstitutionRequest): Promise<Institution> {
    const res = await fetch(`${API_BASE_URL}/api/institutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<Institution>(res);
  },

  async getInstitution(id: string): Promise<Institution> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}`);
    return handleResponse<Institution>(res);
  },

  async rotateKeys(id: string): Promise<{ keyVersion: string; rotatedAt: string }> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}/rotate-key`, { method: 'POST' });
    return handleResponse<{ keyVersion: string; rotatedAt: string }>(res);
  },

  async patchInstitution(id: string, req: UpdateInstitutionRequest): Promise<Institution> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<Institution>(res);
  },

  async getDepositStatus(id: string): Promise<RelayerApprovalResponse> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}/deposit-status`);
    return handleResponse<RelayerApprovalResponse>(res);
  },

  async approveRelayer(id: string): Promise<RelayerApprovalResponse> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}/approve-relayer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return handleResponse<RelayerApprovalResponse>(res);
  },

  async withdrawFromDeposit(id: string, req: WithdrawRequest): Promise<WithdrawResponse> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}/withdrawals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<WithdrawResponse>(res);
  },

  async requestAuthChallenge(did: string): Promise<AuthChallenge> {
    const res = await fetch(`${API_BASE_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ did }),
    });
    return handleResponse<AuthChallenge>(res);
  },

  async verifyAuthChallenge(challengeId: string, signature: string, did: string): Promise<AuthSession> {
    const res = await fetch(`${API_BASE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ challengeId, signature, did }),
    });
    const session = await handleResponse<AuthSession>(res);
    apiClient.setAuthSession(session);
    return session;
  },

  async admitAgent(req: AdmitAgentRequest): Promise<AgentAdmission> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<AgentAdmission>(res);
  },

  async provisionAgent(req: ProvisionAgentRequest): Promise<ProvisionAgentResponse> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<ProvisionAgentResponse>(res);
  },

  async submitIntent(req: EncryptedIntentRequest): Promise<IntentAccepted> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<IntentAccepted>(res);
  },

  async getCompletedTrades(from?: string, to?: string): Promise<{ items: CompletedTrade[] }> {
    const url = new URL(`${API_BASE_URL}/api/trades/completed`);
    if (from) url.searchParams.append('from', from);
    if (to) url.searchParams.append('to', to);
    const res = await requestWithOperatorFallback(url.toString(), { headers: {} });
    return handleResponse<{ items: CompletedTrade[] }>(res);
  },

  async getPortfolio(institutionId: string): Promise<Portfolio> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/portfolios/${institutionId}`);
    return handleResponse<Portfolio>(res);
  },

  async getPortfolioHistory(institutionId: string, limit = 50): Promise<PortfolioHistoryEntry[]> {
    const url = new URL(`${API_BASE_URL}/api/portfolios/${institutionId}/history`);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    const res = await requestWithOperatorFallback(url.toString());
    return handleResponse<PortfolioHistoryEntry[]>(res);
  },

  async getReceipt(receiptId: string): Promise<AuditReceipt> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/receipts/${receiptId}`);
    return handleResponse<AuditReceipt>(res);
  },

  async listAgents(status?: 'admitted' | 'revoked'): Promise<Agent[]> {
    const url = new URL(`${API_BASE_URL}/api/agents`);
    if (status) url.searchParams.append('status', status);
    const res = await requestWithOperatorFallback(url.toString());
    return handleResponse<Agent[]>(res);
  },

  async getAgent(id: string): Promise<Agent> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${id}`);
    return handleResponse<Agent>(res);
  },

  async updateAgentLabel(id: string, label: string): Promise<Agent> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    return handleResponse<Agent>(res);
  },

  async revokeAgent(id: string): Promise<Agent> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${id}/revoke`, { method: 'POST' });
    return handleResponse<Agent>(res);
  },

  async mintDelegation(
    id: string,
    policy?: {
      maxSpendUsd: number;
      allowedCategories: string[];
      approverEmail?: string;
      purpose?: string;
      validityMonths?: number;
    },
  ): Promise<{ authorityRef: string; policyHash: string }> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${id}/delegation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy ?? {}),
    });
    return handleResponse<{ authorityRef: string; policyHash: string }>(res);
  },

  async listHostedAgents(running?: boolean): Promise<HostedAgentRecord[]> {
    const url = new URL(`${API_BASE_URL}/api/hosted-agents`);
    if (running !== undefined) {
      url.searchParams.set('running', String(running));
    }
    const res = await requestWithOperatorFallback(url.toString());
    return handleResponse<HostedAgentRecord[]>(res);
  },

  async getHostedAgent(id: string): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/hosted-agents/${id}`);
    return handleResponse<HostedAgentRecord>(res);
  },

  async createHostedAgent(req: CreateHostedAgentRequest): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/hosted-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return handleResponse<HostedAgentRecord>(res);
  },

  async startHostedAgent(id: string): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/hosted-agents/${id}/start`, { method: 'POST' });
    return handleResponse<HostedAgentRecord>(res);
  },

  async stopHostedAgent(id: string): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/hosted-agents/${id}/stop`, { method: 'POST' });
    return handleResponse<HostedAgentRecord>(res);
  },

  async createNegotiationMandate(
    agentId: string,
    mandate: CreateNegotiationMandateRequest,
  ): Promise<{ mandate: { id: string }; authorityRef: string; policyHash: string }> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${agentId}/mandate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mandate),
    });
    return handleResponse<{ mandate: { id: string }; authorityRef: string; policyHash: string }>(res);
  },

  async getNegotiationMandate(agentId: string): Promise<NegotiationMandateSummary> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${agentId}/mandate`);
    return handleResponse<NegotiationMandateSummary>(res);
  },

  async listNegotiationMandates(agentId: string): Promise<NegotiationMandateSummary[]> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/agents/${agentId}/mandates`);
    const payload = await handleResponse<{ mandates: NegotiationMandateSummary[] }>(res);
    return payload.mandates;
  },

  async listNegotiationSessions(): Promise<NegotiationSession[]> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/negotiations`);
    const payload = await handleResponse<{ sessions: NegotiationSession[] }>(res);
    return payload.sessions;
  },

  async getNegotiationSession(id: string): Promise<NegotiationSession> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/negotiations/${id}`);
    return handleResponse<NegotiationSession>(res);
  },

  async approveNegotiationEscalation(
    sessionId: string,
  ): Promise<{ status: NegotiationSession['status'] }> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/negotiations/${sessionId}/escalation/approve`,
      { method: 'POST' },
    );
    return handleResponse<{ status: NegotiationSession['status'] }>(res);
  },

  async declineNegotiationEscalation(
    sessionId: string,
    reason?: string,
  ): Promise<{ status: NegotiationSession['status'] }> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/negotiations/${sessionId}/escalation/decline`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(reason ? { reason } : {}) }),
      },
    );
    return handleResponse<{ status: NegotiationSession['status'] }>(res);
  },
};
