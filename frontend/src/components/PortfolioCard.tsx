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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 var(--spacing-lg)' }}>
        {portfolio.holdings.map((holding) => (
          <div
            key={holding.assetCode}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--spacing-sm) 0',
              borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
              <span style={{ fontSize: '1.2rem' }}>{getAssetIcon(holding.assetCode)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {holding.assetCode}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.95rem',
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
          </div>
        ))}
      </div>
    </div>
  );
}

export default PortfolioCard;
