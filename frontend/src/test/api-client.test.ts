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
