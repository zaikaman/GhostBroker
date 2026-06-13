import React, { useState, useEffect } from 'react';

export interface PortfolioHistoryEntry {
  id: string;
  institutionId: string;
  assetCode: string;
  delta: number;
  balanceAfter: number;
  changeType: 'settlement_buy' | 'settlement_sell' | 'adjustment' | 'seed';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

interface PortfolioHistoryProps {
  institutionId: string;
  token: string;
}

const CHANGE_TYPE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  settlement_buy: { label: 'Settlement (Buy)', icon: '🟢', color: 'var(--color-success)' },
  settlement_sell: { label: 'Settlement (Sell)', icon: '🔴', color: 'var(--color-error)' },
  adjustment: { label: 'Adjustment', icon: '🔧', color: 'var(--color-warning)' },
  seed: { label: 'Initial Seed', icon: '🌱', color: 'var(--color-accent)' },
};

function formatValue(value: number, asset: string): string {
  if (asset === 'USD') {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function formatDelta(value: number, asset: string): string {
  const sign = value >= 0 ? '+' : '';
  if (asset === 'USD') {
    return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function getAssetIcon(asset: string): string {
  switch (asset) {
    case 'USD': return '💵';
    case 'BTC': return '₿';
    case 'ETH': return '⟠';
    case 'AAPL': return '🍎';
    default: return '📦';
  }
}

export function PortfolioHistory({ institutionId, token }: PortfolioHistoryProps): React.JSX.Element | null {
  const [history, setHistory] = useState<PortfolioHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      setIsLoading(true);
      setError(null);
      try {
        const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
        const res = await fetch(`${API_BASE_URL}/api/portfolios/${institutionId}/history`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as PortfolioHistoryEntry[];
        if (!cancelled) setHistory(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Failed to load portfolio history');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchHistory();
    return () => { cancelled = true; };
  }, [institutionId, token]);

  if (isLoading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 'var(--spacing-xl)' }}>
        <span className="pulse-dot" style={{ marginRight: '8px' }}></span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          Loading balance history...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-lg)' }}>
        <div style={{ fontSize: '0.75rem' }}>⚠️ Portfolio history unavailable</div>
      </div>
    );
  }

  if (history.length === 0) {
    return null; // Don't show the section if there's no history yet
  }

  return (
    <div className="card">
      <h3 className="card-title" style={{ fontSize: '0.85rem', marginBottom: 'var(--spacing-md)' }}>
        <span>📊</span> Balance Change History
      </h3>
      <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
        {history.map((entry) => {
          const typeInfo = CHANGE_TYPE_LABELS[entry.changeType] ?? { label: entry.changeType, icon: '❓', color: 'var(--color-text-muted)' };
          return (
            <div
              key={entry.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--spacing-sm) var(--spacing-md)',
                background: 'var(--color-input-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.75rem',
                gap: 'var(--spacing-sm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', minWidth: 0, flex: 1 }}>
                <span style={{ flexShrink: 0 }}>{typeInfo.icon}</span>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.75rem' }}>
                      {getAssetIcon(entry.assetCode)} {entry.assetCode}
                    </span>
                    <span
                      style={{
                        fontSize: '0.65rem',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-sm)',
                        background: typeInfo.color + '15',
                        color: typeInfo.color,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {typeInfo.label}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', marginTop: '1px' }}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    color: entry.delta >= 0 ? 'var(--color-success)' : 'var(--color-error)',
                  }}
                >
                  {formatDelta(entry.delta, entry.assetCode)}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-text-muted)' }}>
                  Balance: {formatValue(entry.balanceAfter, entry.assetCode)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PortfolioHistory;
