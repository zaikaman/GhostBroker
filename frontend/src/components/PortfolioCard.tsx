import React, { useState, useEffect } from 'react';
import { apiClient } from '../services/api-client';
import {
  Wallet01Icon,
  BitcoinIcon,
  EthereumIcon,
  Dollar01Icon,
  DatabaseIcon,
  LockIcon,
  AlertCircleIcon
} from 'hugeicons-react';

export interface PortfolioHolding {
  assetCode: string;
  balance: number;
  locked: number;
}

export interface Portfolio {
  institutionId: string;
  holdings: PortfolioHolding[];
}

function isStableAsset(asset: string): boolean {
  return asset === 'USDC' || asset === 'USD' || asset === 'USDT';
}

function assetLabel(asset: string): string {
  switch (asset) {
    case 'WBTC': return 'WBTC';
    case 'SEPOLIAETH': return 'SepoliaETH';
    case 'USDC': return 'USDC';
    case 'USD': return 'USD';
    case 'USDT': return 'USDT';
    default: return asset;
  }
}

interface PortfolioCardProps {
  institutionId: string;
}

export function PortfolioCard({ institutionId }: PortfolioCardProps): React.JSX.Element {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchPortfolio() {
      setIsLoading(true);
      setError(null);
      try {
        const data = await apiClient.getPortfolio(institutionId);
        if (!cancelled) setPortfolio(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Failed to load portfolio');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPortfolio();
    return () => { cancelled = true; };
  }, [institutionId]);

  const formatBalance = (value: number, asset: string) => {
    if (isStableAsset(asset)) {
      return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  };

  const getAssetIcon = (asset: string) => {
    switch (asset) {
      case 'WBTC': return <BitcoinIcon size={16} style={{ color: 'var(--color-accent)' }} />;
      case 'SEPOLIAETH': return <EthereumIcon size={16} style={{ color: 'var(--color-accent)' }} />;
      case 'USDC':
      case 'USD':
      case 'USDT': return <Dollar01Icon size={16} style={{ color: 'var(--color-accent)' }} />;
      default: return <DatabaseIcon size={16} style={{ color: 'var(--color-accent)' }} />;
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
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-lg)', gap: 'var(--spacing-sm)' }}>
        <AlertCircleIcon size={24} style={{ color: 'var(--color-error)' }} />
        <div style={{ fontSize: '0.8rem' }}>Portfolio unavailable</div>
      </div>
    );
  }

  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-xl)', gap: 'var(--spacing-sm)' }}>
        <Wallet01Icon size={32} style={{ opacity: 0.5, color: 'var(--color-text-muted)' }} />
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
          Awaiting portfolio snapshot
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', maxWidth: '22rem' }}>
          Balances are loaded from a Sepolia custody or testnet snapshot. T3N operational credits are tracked separately.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Wallet01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Mirrored Portfolio
      </h2>
      <div style={{ marginBottom: 'var(--spacing-sm)', fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
        Tradeable Sepolia assets mirrored from custody or a signed snapshot.
      </div>
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
              <span style={{ display: 'flex', alignItems: 'center' }}>{getAssetIcon(holding.assetCode)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {assetLabel(holding.assetCode)}
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
                <span style={{ fontSize: '0.65rem', color: 'var(--color-warning)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <LockIcon size={10} style={{ color: 'var(--color-warning)' }} /> {formatBalance(holding.locked, holding.assetCode)} locked
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
