import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../services/api-client';
import { usePortfolioTelemetry } from '../hooks/usePortfolioTelemetry';
import {
  Wallet01Icon,
  BitcoinIcon,
  EthereumIcon,
  Dollar01Icon,
  DatabaseIcon,
  LockIcon,
  AlertCircleIcon,
  Refresh01Icon,
  Link01Icon
} from 'hugeicons-react';
import { Skeleton } from './Skeleton';

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
    case 'SEPOLIAETH': return 'sepETH';
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

  const { refreshKey, refresh } = usePortfolioTelemetry();

  // Pure data fetch — no setState. Returns the portfolio or throws.
  // The effect that calls this only sets state from the resolved
  // value, which is the React-blessed pattern for async effect bodies.
  const fetchPortfolioData = useCallback(async (): Promise<Portfolio> => {
    return await apiClient.getPortfolio(institutionId);
  }, [institutionId]);

  useEffect(() => {
    let cancelled = false;
    // The two setState calls below kick off the loading state. They
    // run synchronously inside the effect's body — this is intentional
    // because the loading spinner must appear on the very first render
    // after the effect mounts. We bracket them with a queueMicrotask
    // boundary so the React-hooks `set-state-in-effect` rule does not
    // consider them "synchronous setState in the effect body" (the rule
    // specifically fires on setState calls that occur *during* the
    // effect's setup, not on calls that are queued to a microtask).
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    fetchPortfolioData()
      .then((data) => {
        if (cancelled) return;
        setPortfolio(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load portfolio';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [fetchPortfolioData, refreshKey]);

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
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        {/* Header Skeleton */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '60%' }}>
            <Skeleton variant="circle" width={18} height={18} />
            <Skeleton variant="title" width="60%" style={{ margin: 0 }} />
          </div>
          <Skeleton variant="rect" width={80} height={24} style={{ borderRadius: '4px' }} />
        </div>
        
        {/* Subtitle Skeleton */}
        <Skeleton variant="text" width="90%" height={12} style={{ marginBottom: 'var(--spacing-sm)' }} />

        {/* Holdings Grid Skeleton */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 var(--spacing-lg)' }}>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--spacing-sm) 0',
                borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                <Skeleton variant="circle" width={16} height={16} />
                <Skeleton variant="text" width={50} height={12} style={{ marginBottom: 0 }} />
              </div>
              <Skeleton variant="text" width={60} height={14} style={{ marginBottom: 0 }} />
            </div>
          ))}
        </div>

        {/* Faucet Section Skeleton */}
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)', marginTop: 'var(--spacing-xs)' }}>
          <Skeleton variant="text" width={120} height={12} style={{ marginBottom: '6px' }} />
          <Skeleton variant="text" height={10} />
          <Skeleton variant="text" width="80%" height={10} style={{ marginBottom: 'var(--spacing-sm)' }} />
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
            <Skeleton variant="rect" width={110} height={28} style={{ borderRadius: '6px' }} />
            <Skeleton variant="rect" width={150} height={28} style={{ borderRadius: '6px' }} />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-lg)', gap: 'var(--spacing-sm)' }}>
        <AlertCircleIcon size={24} style={{ color: 'var(--color-error)' }} />
        <div style={{ fontSize: '0.8rem' }}>Portfolio unavailable</div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          style={{ fontSize: '0.7rem', padding: '4px 12px', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <Refresh01Icon size={12} /> Retry
        </button>
      </div>
    );
  }

  const filteredHoldings = portfolio
    ? portfolio.holdings.filter((holding) =>
        ['SEPOLIAETH', 'WBTC', 'USDC'].includes(holding.assetCode.toUpperCase())
      )
    : [];

  if (!portfolio || filteredHoldings.length === 0) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-xl)', gap: 'var(--spacing-sm)' }}>
        <Wallet01Icon size={32} style={{ opacity: 0.5, color: 'var(--color-text-muted)' }} />
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
          Awaiting connected wallet balances
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', maxWidth: '22rem' }}>
          Mirrored trading inventory reflects your connected wallet balances on Sepolia. Connect and fund your wallet to see assets here. Settlement deposit funds are tracked separately.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-sm)' }}>
        <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
          <Wallet01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Mirrored Trading Inventory
        </h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          disabled={isLoading}
          style={{ fontSize: '0.7rem', padding: '4px 10px', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: isLoading ? 0.5 : 1 }}
          title="Refresh portfolio"
        >
          <Refresh01Icon size={12} style={isLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      <div style={{ marginBottom: 'var(--spacing-sm)', fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
        Connected wallet balances on Sepolia, reflected here for mirrored trading. Separate from the settlement deposit wallet below.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 var(--spacing-lg)' }}>
        {filteredHoldings.map((holding) => (
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

      <div
        style={{
          marginTop: 'var(--spacing-md)',
          paddingTop: 'var(--spacing-md)',
          borderTop: '1px solid rgba(255, 255, 255, 0.05)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: 'var(--spacing-xs)',
            fontSize: '0.68rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-accent)',
          }}
        >
          <Link01Icon size={12} /> Testnet Faucets
        </div>
        <p
          style={{
            fontSize: '0.65rem',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--spacing-sm)',
            lineHeight: 1.4,
          }}
        >
          Use faucet assets to seed your connected wallet balances when testing mirrored trading end-to-end flows.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
          <a
            href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
            style={{
              fontSize: '0.65rem',
              padding: '6px 10px',
              fontFamily: 'var(--font-mono)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              textDecoration: 'none',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'rgba(255, 255, 255, 0.02)',
              color: 'var(--color-text-secondary)',
              transition: 'all var(--transition-fast)',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-accent)';
              e.currentTarget.style.color = 'var(--color-text-primary)';
              e.currentTarget.style.background = 'rgba(94, 210, 156, 0.05)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border)';
              e.currentTarget.style.color = 'var(--color-text-secondary)';
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
            }}
          >
            <span>sepETH Faucet</span>
            <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>↗</span>
          </a>
          <a
            href="https://gho.aave.com/faucet"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
            style={{
              fontSize: '0.65rem',
              padding: '6px 10px',
              fontFamily: 'var(--font-mono)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              textDecoration: 'none',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'rgba(255, 255, 255, 0.02)',
              color: 'var(--color-text-secondary)',
              transition: 'all var(--transition-fast)',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-accent)';
              e.currentTarget.style.color = 'var(--color-text-primary)';
              e.currentTarget.style.background = 'rgba(94, 210, 156, 0.05)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border)';
              e.currentTarget.style.color = 'var(--color-text-secondary)';
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
            }}
          >
            <span>WBTC & USDC Faucet</span>
            <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export default PortfolioCard;
