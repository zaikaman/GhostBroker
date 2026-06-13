import { useState, useEffect, useCallback } from 'react';
import { telemetryClient } from '../services/telemetry-client';

/**
 * Hook that listens for `telemetry.portfolio.changed` WebSocket events.
 * Returns a `refreshKey` that increments each time a portfolio update is received,
 * so components can use it as a dependency to re-fetch portfolio data.
 */
export function usePortfolioTelemetry(): {
  refreshKey: number;
  refresh: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const unsubscribe = telemetryClient.onMessage((event) => {
      if (
        event.type === 'telemetry.portfolio.changed' &&
        event.phase === 'portfolio_updated'
      ) {
        setRefreshKey((prev) => prev + 1);
      }
    });

    return unsubscribe;
  }, []);

  const refresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  return { refreshKey, refresh };
}

export default usePortfolioTelemetry;
