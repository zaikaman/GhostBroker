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

  const fetchTrades = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.getCompletedTrades(from, to);
      setTrades(response.items || []);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  return {
    trades,
    isLoading,
    error,
    refetch: fetchTrades,
  };
}

export default useTradeHistory;
