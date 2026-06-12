import React from 'react';
import type { CompletedTrade } from '../services/api-client';

export interface CompletedTradesTableProps {
  trades: CompletedTrade[];
  isLoading: boolean;
  onViewReceipt: (receiptId: string) => void;
}

export function CompletedTradesTable({
  trades,
  isLoading,
  onViewReceipt,
}: CompletedTradesTableProps): React.JSX.Element {
  const truncateCiphertext = (text: string | undefined) => {
    if (!text) return '🔒 [ENCRYPTED]';
    if (text.length <= 20) return text;
    if (text.endsWith('sealed')) {
      return `${text.slice(0, 11)}...${text.slice(-6)}`;
    }
    return `${text.slice(0, 10)}...${text.slice(-8)}`;
  };

  if (isLoading) {
    return (
      <div 
        className="table-container" 
        style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center', 
          padding: 'var(--spacing-2xl)',
          color: 'var(--color-text-secondary)',
          fontFamily: 'var(--font-mono)'
        }}
      >
        <span className="pulse-dot" style={{ marginRight: '8px' }}></span>
        Querying secure trade history ledger...
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div 
        className="card" 
        style={{ 
          textAlign: 'center', 
          color: 'var(--color-text-muted)', 
          padding: 'var(--spacing-xl)',
          borderStyle: 'dashed',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--spacing-sm)'
        }}
      >
        <div style={{ fontSize: '1.5rem', opacity: 0.7 }}>📜</div>
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.9rem' }}>
          No completed trades recorded
        </div>
        <div style={{ fontSize: '0.8rem' }}>
          Secure connection active. Settlement logs will appear once counterparties settle privately.
        </div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table className="trades-table" aria-label="Completed Trades History">
        <thead>
          <tr>
            <th scope="col">Trade Ref</th>
            <th scope="col">Asset Ticker</th>
            <th scope="col">Quantity</th>
            <th scope="col">Execution Price</th>
            <th scope="col">Status</th>
            <th scope="col">Settled At</th>
            <th scope="col">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const hasReceipt = trade.receiptIds && trade.receiptIds.length > 0;
            const primaryReceiptId = hasReceipt ? trade.receiptIds[0] : null;

            return (
              <tr key={trade.id} tabIndex={0} className="trade-row">
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  {trade.tradeRef}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-accent)' }}>
                  🔒 {truncateCiphertext(trade.assetCodeCiphertext)}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  🔒 {truncateCiphertext(trade.quantityCiphertext)}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  🔒 {truncateCiphertext(trade.executionPriceCiphertext)}
                </td>
                <td>
                  <span 
                    className={`status-badge ${
                      trade.settlementStatus === 'settled' 
                        ? 'secure' 
                        : trade.settlementStatus === 'failed' 
                        ? 'error' 
                        : 'processing'
                    }`}
                  >
                    {trade.settlementStatus}
                  </span>
                </td>
                <td style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                  {new Date(trade.settledAt).toLocaleString()}
                </td>
                <td>
                  {primaryReceiptId ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: 'var(--spacing-xs) var(--spacing-sm)', fontSize: '0.75rem' }}
                      onClick={() => onViewReceipt(primaryReceiptId)}
                      aria-label={`View audit receipt for trade ${trade.tradeRef}`}
                    >
                      🛡️ Audit Receipt
                    </button>
                  ) : (
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      Unavailable
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default CompletedTradesTable;
