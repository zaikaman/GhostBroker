import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../services/api-client';
import type { CompletedTrade } from '../services/api-client';

export interface UseTradeHistoryResult {
  trades: CompletedTrade[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useTradeHistory(from?: string, to?: string): UseTradeHistoryResult {
  const [trades, setTrades] = useState<CompletedTrade[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Pure data fetch — no setState. The effect that consumes this
  // only sets state from the resolved value, which is the
  // React-blessed pattern for async effect bodies.
  const fetchTradesData = useCallback(async (): Promise<CompletedTrade[]> => {
    const response = await apiClient.getCompletedTrades(from, to);
    return response.items || [];
  }, [from, to]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    fetchTradesData()
      .then((items) => {
        if (cancelled) return;
        setTrades(items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [fetchTradesData]);

  return {
    trades,
    isLoading,
    error,
    refetch: async () => {
      const items = await fetchTradesData();
      setTrades(items);
    },
  };
}

export default useTradeHistory;
