import React, { useState } from 'react';
import type { CompletedTrade } from '../services/api-client';
import { LockIcon, ScrollIcon, Shield01Icon } from 'hugeicons-react';
import { Pagination } from './Pagination';

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
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 8;

  const truncateCiphertext = (text: string | undefined) => {
    if (!text) return <><LockIcon size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} /> [ENCRYPTED]</>;
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
        <ScrollIcon size={28} style={{ opacity: 0.5, color: 'var(--color-text-muted)' }} />
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.9rem' }}>
          No completed trades recorded
        </div>
        <div style={{ fontSize: '0.8rem' }}>
          Secure connection active. Settlement logs will appear once counterparties settle privately.
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(trades.length / itemsPerPage);
  
  // Guard current page bounds if trades count changes
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedTrades = trades.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  return (
    <div className="table-container" style={{ padding: 'var(--spacing-md)' }}>
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
          {paginatedTrades.map((trade) => {
            const hasReceipt = trade.receiptIds && trade.receiptIds.length > 0;
            const primaryReceiptId = hasReceipt ? trade.receiptIds[0] : null;

            return (
              <tr key={trade.id} tabIndex={0} className="trade-row">
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  {trade.tradeRef}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-accent)' }}>
                  <LockIcon size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '2px' }} /> {truncateCiphertext(trade.assetCodeCiphertext)}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  <LockIcon size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '2px' }} /> {truncateCiphertext(trade.quantityCiphertext)}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  <LockIcon size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '2px' }} /> {truncateCiphertext(trade.executionPriceCiphertext)}
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
                      style={{ padding: 'var(--spacing-xs) var(--spacing-sm)', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      onClick={() => onViewReceipt(primaryReceiptId)}
                      aria-label={`View audit receipt for trade ${trade.tradeRef}`}
                    >
                      <Shield01Icon size={12} /> Audit Receipt
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

      <Pagination
        currentPage={activePage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        totalItems={trades.length}
        itemsPerPage={itemsPerPage}
      />
    </div>
  );
}

export default CompletedTradesTable;
