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

export interface AuditReceipt {
  id: string;
  completedTradeId: string;
  receiptCiphertext: string;
  receiptHash: string;
  keyVersion: string;
  t3AttestationRef: string;
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

const getOperatorHeaders = (): Record<string, string> => {
  const institutionId = localStorage.getItem('x-operator-institution-id') || '00000000-0000-4000-8000-000000000301';
  const operatorId = localStorage.getItem('x-operator-id') || 'operator:unattributed';
  return {
    'x-operator-institution-id': institutionId,
    'x-operator-id': operatorId,
  };
};

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

  async admitAgent(req: AdmitAgentRequest): Promise<AgentAdmission> {
    const res = await fetch(`${API_BASE_URL}/api/agents/admit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...getOperatorHeaders(),
      },
      body: JSON.stringify(req),
    });
    return handleResponse<AgentAdmission>(res);
  },

  async submitIntent(req: EncryptedIntentRequest): Promise<IntentAccepted> {
    const res = await fetch(`${API_BASE_URL}/api/agents/intents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...getOperatorHeaders(),
      },
      body: JSON.stringify(req),
    });
    return handleResponse<IntentAccepted>(res);
  },

  async getCompletedTrades(from?: string, to?: string): Promise<{ items: CompletedTrade[] }> {
    const url = new URL(`${API_BASE_URL}/api/trades/completed`);
    if (from) url.searchParams.append('from', from);
    if (to) url.searchParams.append('to', to);

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        ...getOperatorHeaders(),
      },
    });
    return handleResponse<{ items: CompletedTrade[] }>(res);
  },

  async getReceipt(receiptId: string): Promise<AuditReceipt> {
    const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}`, {
      headers: {
        'Accept': 'application/json',
        ...getOperatorHeaders(),
      },
    });
    return handleResponse<AuditReceipt>(res);
  },
};
