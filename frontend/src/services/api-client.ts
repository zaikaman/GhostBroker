export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  services: Record<string, 'ok' | 'degraded' | 'unavailable'>;
}

export interface CreateInstitutionRequest {
  legalName: string;
  displayName: string;
  /**
   * WS3: settlement profile ref. One of:
   *   - `wallet:default`            â€” noop rail (system default)
   *   - `chain:sepolia:erc20`       â€” Sepolia ERC-20 chain rail
   *   - `custody:<partner>`         â€” future custody rail
   *   - `settlement-profile:<name>`  â€” legacy free-form (back-compat)
   *
   * The chain rail requires `metadata.depositAddress` and
   * `metadata.tokenAddresses` (a `Record<assetCode, address>`
   * map). The backend's Zod schema validates this.
   */
  settlementProfileRef: string;
  /**
   * WS3: per-rail config. For the chain rail, the
   * `depositAddress` and `tokenAddresses` fields are
   * required. For other rails, the field is free-form.
   */
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
  metadata?: Record<string, any>;
}

export interface AdmitAgentRequest {
  institutionId: string;
  agentDid: string;
  /**
   * Post-Phase 1: the delegation VC is owned by the
   * backend. The dashboard mints + persists the VC on
   * the agent record at "Configure Agent" time; the
   * agent process never holds or sends the VC. The
   * optional field is kept for forward-compat
   * (custom integrations, E2E tests).
   */
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
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAdmission {
  id?: string;
  agentDid: string;
  status: 'admitted' | 'rejected';
  authorityRef: string;
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
  /**
   * WS1: rail transport proof fields. For the noop rail
   * the values are `null` (no external transport). For
   * the chain rail the values are the contract id and
   * the on-chain tx hash.
   */
  railId: string | null;
  railTradeRef: string | null;
  /**
   * WS1: mirrors `settlementStatus` for symmetry. `null`
   * for pre-WS1 rows.
   */
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

export interface ApiKey {
  id: string;
  institutionId: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

export type HostedAgentPreset = 'buyer' | 'seller' | 'custom';

export interface HostedAgentConfig {
  mode: HostedAgentPreset;
  label: string;
  side: 'buy' | 'sell';
  assetCode: string;
  quoteAssetCode: string;
  operatorPrompt: string;
  referencePrice: number;
  priceBandBps: number;
  quantityMin: number;
  quantityMax: number;
  tickIntervalMs: number;
  maxTicks: number;
  dryRun: boolean;
  groqModel?: string;
}

export interface HostedAgentRuntimeStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number;
  lastSignal?: string;
  apiKeyId?: string;
  lastError?: string;
  logTail: string;
}

export interface HostedAgentRecord {
  agent: Agent;
  config: HostedAgentConfig;
  runtime: HostedAgentRuntimeStatus;
}

export interface CreateHostedAgentRequest {
  institutionId: string;
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
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiClientError);
    }
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');

const AUTH_TOKEN_KEY = 'ghostbroker-auth-token';
const AUTH_SESSION_KEY = 'ghostbroker-auth-session';

const getOperatorHeaders = (): Record<string, string> => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  // No valid bearer token available. Sending the operator identity headers
  // without a real signed JWT would always result in a 401 from the backend.
  // Return an empty header map so the request fails fast with a clear,
  // unauthenticated error instead of looping on a stale token.
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

  headers['Accept'] = headers['Accept'] ?? 'application/json';

  for (const [key, value] of Object.entries(getOperatorHeaders())) {
    headers[key] = value;
  }

  return {
    ...init,
    headers,
  };
}

async function requestWithOperatorFallback(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
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
      // Body is not JSON, fallback to generic messages based on status
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

    // No valid session. Never fabricate a synthetic session with a fake
    // `e2e-bypass-token` â€” the backend has no way to validate it and every
    // authenticated request would fail with 401. Callers must use the real
    // DID challenge/verify flow (wallet auth) to obtain a signed JWT.
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
      headers: {
        'Accept': 'application/json',
      },
    });
    return handleResponse<HealthResponse>(res);
  },

  async createInstitution(req: CreateInstitutionRequest): Promise<Institution> {
    const res = await fetch(`${API_BASE_URL}/api/institutions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req),
    });
    return handleResponse<Institution>(res);
  },

  async getInstitution(id: string): Promise<Institution> {
    const res = await requestWithOperatorFallback(`${API_BASE_URL}/api/institutions/${id}`);
    return handleResponse<Institution>(res);
  },

  async rotateKeys(id: string): Promise<Institution> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/institutions/${id}/rotate-key`,
      { method: 'POST' },
    );
    return handleResponse<Institution>(res);
  },

  /**
   * WS3: PATCH an institution's settlement profile and/or
   * chain-rail metadata. The route is operator-scoped; the
   * backend validates that profile + metadata satisfy the
   * chain-rail superRefine when applicable.
   */
  async patchInstitution(
    id: string,
    req: UpdateInstitutionRequest,
  ): Promise<Institution> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/institutions/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      },
    );
    return handleResponse<Institution>(res);
  },

  /**
   * Read the institution's deposit wallet status: on-chain
   * balances and whether the relayer is approved per token.
   * Chain-rail institutions only; operator-scoped.
   */
  async getDepositStatus(id: string): Promise<RelayerApprovalResponse> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/institutions/${id}/deposit-status`,
    );
    return handleResponse<RelayerApprovalResponse>(res);
  },

  /**
   * Approve the settlement relayer to move ERC-20 tokens out of
   * the institution's server-owned deposit wallet. The backend
   * holds the deposit wallet key and signs the approval.
   * Chain-rail institutions only; operator-scoped.
   */
  async approveRelayer(id: string): Promise<RelayerApprovalResponse> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/institutions/${id}/approve-relayer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    return handleResponse<RelayerApprovalResponse>(res);
  },

  /**
   * Withdraw assets from the institution's deposit wallet to an
   * external destination. The backend signs and broadcasts the
   * transfer. Chain-rail institutions only; operator-scoped.
   */
  async withdrawFromDeposit(
    id: string,
    req: WithdrawRequest,
  ): Promise<WithdrawResponse> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/institutions/${id}/withdrawals`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      },
    );
    return handleResponse<WithdrawResponse>(res);
  },

  async requestAuthChallenge(did: string): Promise<AuthChallenge> {
    const res = await fetch(`${API_BASE_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ did }),
    });
    return handleResponse<AuthChallenge>(res);
  },

  async verifyAuthChallenge(req: {
    challengeId: string;
    did: string;
    signature: string;
    walletAddress?: string;
  }): Promise<AuthSession> {
    const res = await fetch(`${API_BASE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req),
    });
    const session = await handleResponse<AuthSession>(res);
    this.setAuthSession(session);
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

    const res = await requestWithOperatorFallback(url.toString(), {
      headers: {},
    });
    return handleResponse<{ items: CompletedTrade[] }>(res);
  },

  async getPortfolio(institutionId: string): Promise<Portfolio> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/portfolios/${institutionId}`,
    );
    return handleResponse<Portfolio>(res);
  },

  async getPortfolioHistory(
    institutionId: string,
    limit = 50,
  ): Promise<PortfolioHistoryEntry[]> {
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

  // â”€â”€ Agent Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async listAgents(status?: "admitted" | "revoked"): Promise<Agent[]> {
    const url = new URL(`${API_BASE_URL}/api/agents`);
    if (status) url.searchParams.append("status", status);

    const res = await requestWithOperatorFallback(url.toString());
    return handleResponse<Agent[]>(res);
  },

  async getAgent(id: string): Promise<Agent> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/agents/${id}`,
    );
    return handleResponse<Agent>(res);
  },

  async updateAgentLabel(id: string, label: string): Promise<Agent> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/agents/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );
    return handleResponse<Agent>(res);
  },

  async revokeAgent(id: string): Promise<void> {
    await requestWithOperatorFallback(
      `${API_BASE_URL}/api/agents/${id}/revoke`,
      { method: "POST" },
    );
  },

  async mintDelegation(
    id: string,
    policy: {
      maxSpendUsd: number;
      allowedCategories: string[];
      approverEmail?: string;
      purpose?: string;
      validityMonths?: number;
    },
  ): Promise<{ authorityRef: string; policyHash: string }> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/agents/${id}/delegation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      },
    );
    return handleResponse<{ authorityRef: string; policyHash: string }>(res);
  },

  // â”€â”€ API Key Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async listApiKeys(): Promise<ApiKey[]> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/keys`,
    );
    return handleResponse<ApiKey[]>(res);
  },

  async createApiKey(label: string, scopes?: string[]): Promise<CreatedApiKey> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/keys`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, scopes: scopes ?? ['agent:operate'] }),
      },
    );
    return handleResponse<CreatedApiKey>(res);
  },

  async revokeApiKey(id: string): Promise<void> {
    await requestWithOperatorFallback(
      `${API_BASE_URL}/api/keys/${id}/revoke`,
      { method: 'POST' },
    );
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
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/hosted-agents/${id}`,
    );
    return handleResponse<HostedAgentRecord>(res);
  },

  async createHostedAgent(req: CreateHostedAgentRequest): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/hosted-agents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      },
    );
    return handleResponse<HostedAgentRecord>(res);
  },

  async startHostedAgent(id: string): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/hosted-agents/${id}/start`,
      { method: 'POST' },
    );
    return handleResponse<HostedAgentRecord>(res);
  },

  async stopHostedAgent(id: string): Promise<HostedAgentRecord> {
    const res = await requestWithOperatorFallback(
      `${API_BASE_URL}/api/hosted-agents/${id}/stop`,
      { method: 'POST' },
    );
    return handleResponse<HostedAgentRecord>(res);
  },
};

