import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../services/api-client';
import {
  Activity01Icon,
  BitcoinIcon,
  EthereumIcon,
  Dollar01Icon,
  DatabaseIcon,
  Wrench01Icon,
  CheckmarkCircle01Icon,
  CancelCircleIcon,
  ScrollIcon,
  AlertCircleIcon
} from 'hugeicons-react';
import { Pagination } from './Pagination';
import { Skeleton } from './Skeleton';

export interface PortfolioHistoryEntry {
  id: string;
  institutionId: string;
  assetCode: string;
  delta: number;
  balanceAfter: number;
  changeType: 'settlement_buy' | 'settlement_sell' | 'adjustment' | 'import';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

interface PortfolioHistoryProps {
  institutionId: string;
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

const CHANGE_TYPE_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  settlement_buy: { label: 'Settlement (Buy)', icon: <CheckmarkCircle01Icon size={12} />, color: 'var(--color-success)' },
  settlement_sell: { label: 'Settlement (Sell)', icon: <CancelCircleIcon size={12} />, color: 'var(--color-error)' },
  adjustment: { label: 'Adjustment', icon: <Wrench01Icon size={12} />, color: 'var(--color-warning)' },
  import: { label: 'Imported Sepolia Snapshot', icon: <DatabaseIcon size={12} />, color: 'var(--color-accent)' },
};

function formatValue(value: number, asset: string): string {
  if (isStableAsset(asset)) {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function formatDelta(value: number, asset: string): string {
  const sign = value >= 0 ? '+' : '';
  if (isStableAsset(asset)) {
    return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function getAssetIcon(asset: string): React.ReactNode {
  switch (asset) {
    case 'WBTC': return <BitcoinIcon size={12} style={{ color: 'var(--color-accent)' }} />;
    case 'SEPOLIAETH': return <EthereumIcon size={12} style={{ color: 'var(--color-accent)' }} />;
    case 'USDC':
    case 'USD':
    case 'USDT': return <Dollar01Icon size={12} style={{ color: 'var(--color-accent)' }} />;
    default: return <DatabaseIcon size={12} style={{ color: 'var(--color-accent)' }} />;
  }
}

export function PortfolioHistory({ institutionId }: PortfolioHistoryProps): React.JSX.Element | null {
  const [history, setHistory] = useState<PortfolioHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  const fetchHistoryData = useCallback(async (): Promise<PortfolioHistoryEntry[]> => {
    return await apiClient.getPortfolioHistory(institutionId);
  }, [institutionId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    fetchHistoryData()
      .then((data) => {
        if (cancelled) return;
        setHistory(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load portfolio history';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [fetchHistoryData, institutionId]);

  if (isLoading) {
    return (
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '350px', gap: 'var(--spacing-md)' }}>
        {/* Title Skeleton */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: 'var(--spacing-xs)' }}>
          <Skeleton variant="circle" width={16} height={16} />
          <Skeleton variant="title" width="40%" style={{ margin: 0 }} />
        </div>

        {/* Paginated entries Skeleton */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
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
                <Skeleton variant="circle" width={12} height={12} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '50%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Skeleton variant="text" width="40%" height={12} style={{ marginBottom: 0 }} />
                    <Skeleton variant="rect" width={80} height={16} style={{ borderRadius: '4px' }} />
                  </div>
                  <Skeleton variant="text" width="60%" height={10} style={{ marginBottom: 0 }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', width: '25%' }}>
                <Skeleton variant="text" width="100%" height={12} style={{ marginBottom: 0 }} />
                <Skeleton variant="text" width="70%" height={10} style={{ marginBottom: 0 }} />
              </div>
            </div>
          ))}
        </div>

        {/* Pagination Skeleton */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
          <Skeleton variant="rect" width={80} height={28} style={{ borderRadius: '4px' }} />
          <Skeleton variant="text" width={120} height={12} style={{ marginBottom: 0 }} />
          <Skeleton variant="rect" width={80} height={28} style={{ borderRadius: '4px' }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-lg)', gap: 'var(--spacing-sm)' }}>
        <AlertCircleIcon size={24} style={{ color: 'var(--color-error)' }} />
        <div style={{ fontSize: '0.75rem' }}>Portfolio history unavailable</div>
      </div>
    );
  }

  const filteredHistory = history.filter((entry) =>
    ['SEPOLIAETH', 'WBTC', 'USDC'].includes(entry.assetCode.toUpperCase())
  ).filter((entry) => entry.delta !== 0);

  if (filteredHistory.length === 0) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-xl)', textAlign: 'center', minHeight: '160px', gap: 'var(--spacing-sm)' }}>
        <ScrollIcon size={28} style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
        <div>
          <h4 style={{ margin: 0, fontWeight: 600, fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>
            No mirrored inventory changes recorded
          </h4>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            Awaiting the first imported snapshot or a completed settlement update.
          </p>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(filteredHistory.length / itemsPerPage);
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedHistory = filteredHistory.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '350px' }}>
      <h3 className="card-title" style={{ fontSize: '0.85rem', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Activity01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Mirrored Inventory History
      </h3>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
        {paginatedHistory.map((entry) => {
          const typeInfo = CHANGE_TYPE_LABELS[entry.changeType] ?? { label: entry.changeType, icon: <AlertCircleIcon size={12} />, color: 'var(--color-text-muted)' };
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
                <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: typeInfo.color }}>{typeInfo.icon}</span>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {getAssetIcon(entry.assetCode)} {assetLabel(entry.assetCode)}
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

      <Pagination
        currentPage={activePage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        totalItems={filteredHistory.length}
        itemsPerPage={itemsPerPage}
      />
    </div>
  );
}

export default PortfolioHistory;
