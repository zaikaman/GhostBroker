import { apiClient } from '../services/api-client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('apiClient Services', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getCompletedTrades issues GET with operator authentication headers', async () => {
    apiClient.setOperatorContext('inst_123', 'op_456');

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

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await apiClient.getCompletedTrades('2026-06-11T00:00:00Z');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/trades/completed?from=2026-06-11T00%3A00%3A00Z'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'x-operator-institution-id': 'inst_123',
          'x-operator-id': 'op_456',
        }),
      })
    );
    expect(result).toEqual(mockResponse);
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

    (global.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          institutionId: 'inst_123',
          holdings: [],
        }),
      });

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
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/portfolios/inst_123'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-operator-institution-id': 'inst_123',
          'x-operator-id': 'did:did:t3n:tenant:northstar',
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

    (global.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      });

    const result = await apiClient.getCompletedTrades('2026-06-11T00:00:00Z');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ items: [] });
  });

  it('getReceipt issues GET to /api/receipts/:id with operator headers', async () => {
    apiClient.setOperatorContext('inst_123', 'op_456');

    const mockReceipt = {
      id: 'receipt_1',
      completedTradeId: 'trade_1',
      receiptCiphertext: 'cipher_envelope',
      receiptHash: 'sha256:123',
      keyVersion: 'key-v3',
      t3AttestationRef: 't3_attest',
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockReceipt,
    });

    const result = await apiClient.getReceipt('receipt_1');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/receipts/receipt_1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'x-operator-institution-id': 'inst_123',
          'x-operator-id': 'op_456',
        }),
      })
    );
    expect(result).toEqual(mockReceipt);
  });
});
