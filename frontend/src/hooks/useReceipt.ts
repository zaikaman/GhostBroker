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

  const fetchReceipt = useCallback(async () => {
    if (!receiptId) {
      setReceipt(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getReceipt(receiptId);
      setReceipt(data);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
      setReceipt(null);
    } finally {
      setIsLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    fetchReceipt();
  }, [fetchReceipt]);

  return {
    receipt,
    isLoading,
    error,
    refetch: fetchReceipt,
  };
}

export default useReceipt;
