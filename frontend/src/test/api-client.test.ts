import { apiClient } from '../services/api-client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

type FetchMock = ReturnType<typeof vi.fn>;

function asFetchMock(fetchMock: typeof global.fetch): FetchMock {
  return fetchMock as unknown as FetchMock;
}

describe('apiClient Services', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getCompletedTrades issues GET with bearer authorization header when a session is present', async () => {
    apiClient.setAuthSession({
      token: 'real.jwt.token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      institution: {
        id: 'inst_123',
        displayName: 'Northstar Capital',
        t3TenantDid: 'did:t3n:tenant:northstar',
      },
    });

    const mockResponse = {
      items: [
        {
          id: 'trade_1',
          tradeRef: 'ref_1',
          settlementStatus: 'settled',
          settledAt: '2026-06-12T00:00:00Z',
          receiptIds: ['receipt_1'],
        },
      ],
    };

    asFetchMock(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await apiClient.getCompletedTrades('2026-06-11T00:00:00Z');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/trades/completed?from=2026-06-11T00%3A00%3A00Z'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'Authorization': 'Bearer real.jwt.token',
        }),
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it('getCompletedTrades sends no auth header when there is no session', async () => {
    localStorage.clear();

    asFetchMock(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 'authorization_failed' }),
    } as Response);

    await expect(apiClient.getCompletedTrades()).rejects.toMatchObject({
      status: 401,
      code: 'authorization_failed',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/trades/completed'),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      })
    );
  });

  it('retries portfolio requests once after clearing a stale auth session', async () => {
    apiClient.setAuthSession({
      token: 'stale.jwt.token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      institution: {
        id: 'inst_123',
        displayName: 'Northstar Capital',
        t3TenantDid: 'did:t3n:tenant:northstar',
      },
    });

    asFetchMock(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          institutionId: 'inst_123',
          holdings: [],
        }),
      } as Response);

    const result = await apiClient.getPortfolio('inst_123');

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/portfolios/inst_123'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer stale.jwt.token',
        }),
      })
    );
    // After the 401, the session is cleared and the retry must not
    // fabricate a synthetic Authorization header.
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/portfolios/inst_123'),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      })
    );
    expect(result).toEqual({
      institutionId: 'inst_123',
      holdings: [],
    });
  });

  it('retries completed trades requests once after clearing a stale auth session', async () => {
    apiClient.setAuthSession({
      token: 'stale.jwt.token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      institution: {
        id: 'inst_123',
        displayName: 'Northstar Capital',
        t3TenantDid: 'did:t3n:tenant:northstar',
      },
    });

    asFetchMock(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      } as Response);

    const result = await apiClient.getCompletedTrades('2026-06-11T00:00:00Z');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ items: [] });
  });

  it('getReceipt issues GET to /api/receipts/:id with bearer authorization when a session is present', async () => {
    apiClient.setAuthSession({
      token: 'real.jwt.token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      institution: {
        id: 'inst_123',
        displayName: 'Northstar Capital',
        t3TenantDid: 'did:t3n:tenant:northstar',
      },
    });

    const mockReceipt = {
      id: 'receipt_1',
      completedTradeId: 'trade_1',
      receiptCiphertext: 'cipher_envelope',
      receiptHash: 'sha256:123',
      keyVersion: 'key-v3',
      t3AttestationRef: 't3_attest',
    };

    asFetchMock(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockReceipt,
    } as Response);

    const result = await apiClient.getReceipt('receipt_1');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/receipts/receipt_1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'Authorization': 'Bearer real.jwt.token',
        }),
      })
    );
    expect(result).toEqual(mockReceipt);
  });
});
