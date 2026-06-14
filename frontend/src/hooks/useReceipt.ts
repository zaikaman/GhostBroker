import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../services/api-client';
import type { AuditReceipt } from '../services/api-client';

export interface UseReceiptResult {
  receipt: AuditReceipt | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useReceipt(receiptId: string | null): UseReceiptResult {
  const [receipt, setReceipt] = useState<AuditReceipt | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Pure data fetch — no setState. The effect that consumes this
  // only sets state from the resolved value (or from the null sentinel
  // when there is no receiptId), which is the React-blessed pattern.
  const fetchReceiptData = useCallback(async (): Promise<AuditReceipt | null> => {
    if (!receiptId) {
      return null;
    }
    return await apiClient.getReceipt(receiptId);
  }, [receiptId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    fetchReceiptData()
      .then((data) => {
        if (cancelled) return;
        setReceipt(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setReceipt(null);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [fetchReceiptData]);

  return {
    receipt,
    isLoading,
    error,
    refetch: async () => {
      const data = await fetchReceiptData();
      setReceipt(data);
    },
  };
}

export default useReceipt;
