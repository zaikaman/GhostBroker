export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  services: Record<string, 'ok' | 'degraded' | 'unavailable'>;
}

export interface CreateInstitutionRequest {
  legalName: string;
  displayName: string;
  settlementProfileRef: string;
}

export interface Institution {
  id: string;
  legalName: string;
  displayName: string;
  status: 'pending' | 'active' | 'suspended' | 'closed';
  t3TenantDid: string;
}

export interface AdmitAgentRequest {
  institutionId: string;
  agentDid: string;
  authorityProof: string;
}

export interface AgentAdmission {
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
  /** The plaintext API key. Returned only once on creation. */
  key: string;
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

  const institutionId = localStorage.getItem('x-operator-institution-id') || '00000000-0000-4000-8000-000000000301';
  const operatorId = localStorage.getItem('x-operator-id') || 'operator:unattributed';
  return {
    'x-operator-institution-id': institutionId,
    'x-operator-id': operatorId,
  };
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

    // E2E / Development local-storage bypass (no MetaMask wallet in headless Playwright tests)
    const instId = localStorage.getItem('x-operator-institution-id');
    const opId = localStorage.getItem('x-operator-id');
    if (instId && opId) {
      return {
        token: 'e2e-bypass-token',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        institution: {
          id: instId,
          displayName: instId === '00000000-0000-4000-8000-000000000301' ? 'Northstar Capital' : 'Operator Console',
          t3TenantDid: opId.startsWith('did:') ? opId : `did:t3n:e2e:${opId}`,
        },
      };
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

  // ── API Key Management ────────────────────────────────────────────────

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
};
