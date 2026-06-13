import React, { useState, useEffect } from 'react';

export interface PortfolioHolding {
  assetCode: string;
  balance: number;
  locked: number;
}

export interface Portfolio {
  institutionId: string;
  holdings: PortfolioHolding[];
}

interface PortfolioCardProps {
  institutionId: string;
  token: string;
}

export function PortfolioCard({ institutionId, token }: PortfolioCardProps): React.JSX.Element {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchPortfolio() {
      setIsLoading(true);
      setError(null);
      try {
        const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
        const res = await fetch(`${API_BASE_URL}/api/portfolios/${institutionId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as Portfolio;
        if (!cancelled) setPortfolio(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Failed to load portfolio');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPortfolio();
    return () => { cancelled = true; };
  }, [institutionId, token]);

  const formatBalance = (value: number, asset: string) => {
    if (asset === 'USD') {
      return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  };

  const getAssetIcon = (asset: string) => {
    switch (asset) {
      case 'USD': return '💵';
      case 'BTC': return '₿';
      case 'ETH': return '⟠';
      case 'AAPL': return '🍎';
      default: return '📦';
    }
  };

  if (isLoading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 'var(--spacing-2xl)' }}>
        <span className="pulse-dot" style={{ marginRight: '8px' }}></span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
          Loading portfolio...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-lg)' }}>
        <div style={{ fontSize: '0.8rem' }}>⚠️ Portfolio unavailable</div>
      </div>
    );
  }

  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-xl)' }}>
        <div style={{ fontSize: '1.5rem', opacity: 0.7 }}>🏦</div>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', marginTop: 'var(--spacing-sm)' }}>
          No portfolio data
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card-title">
        <span>🏦</span> Institution Portfolio
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--spacing-md)' }}>
        {portfolio.holdings.map((holding) => (
          <div
            key={holding.assetCode}
            style={{
              background: 'var(--color-input-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--spacing-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--spacing-xs)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="form-label" style={{ margin: 0, fontSize: '0.7rem' }}>{holding.assetCode}</span>
              <span style={{ fontSize: '1.1rem' }}>{getAssetIcon(holding.assetCode)}</span>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '1rem',
                fontWeight: 700,
                color: 'var(--color-text-primary)',
              }}
            >
              {formatBalance(holding.balance, holding.assetCode)}
            </span>
            {holding.locked > 0 && (
              <span style={{ fontSize: '0.65rem', color: 'var(--color-warning)', fontFamily: 'var(--font-mono)' }}>
                🔒 {formatBalance(holding.locked, holding.assetCode)} locked
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default PortfolioCard;
