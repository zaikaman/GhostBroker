import React, { useEffect } from 'react';
import type { AuditReceipt } from '../services/api-client';

export interface EncryptedReceiptDrawerProps {
  receiptId: string | null;
  isOpen: boolean;
  onClose: () => void;
  receipt: AuditReceipt | null;
  isLoading: boolean;
  error: string | null;
}

export function EncryptedReceiptDrawer({
  receiptId,
  isOpen,
  onClose,
  receipt,
  isLoading,
  error,
}: EncryptedReceiptDrawerProps): React.JSX.Element {
  // Support Esc key to close the drawer for accessibility
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <div 
      className={`drawer-backdrop ${isOpen ? 'open' : ''}`} 
      onClick={onClose}
      data-testid="receipt-drawer-backdrop"
    >
      <div 
        className="drawer-content" 
        onClick={(e) => e.stopPropagation()} 
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        data-testid="receipt-drawer"
      >
        <div className="drawer-header">
          <h2 id="drawer-title" className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
            🛡️ Cryptographic Audit Receipt
          </h2>
          <button 
            type="button" 
            className="btn btn-secondary" 
            style={{ padding: 'var(--spacing-xs) var(--spacing-sm)', borderRadius: '50%', width: '32px', height: '32px' }}
            onClick={onClose}
            aria-label="Close audit receipt drawer"
          >
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-md)', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
              <span className="pulse-dot"></span>
              <span>Decrypting enclave audit reference...</span>
            </div>
          ) : error ? (
            <div 
              className="status-badge error" 
              style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'flex-start',
                gap: 'var(--spacing-sm)',
                borderRadius: 'var(--radius-md)', 
                padding: 'var(--spacing-md)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                width: '100%',
                textTransform: 'none',
                lineHeight: '1.4'
              }}
            >
              <div style={{ fontWeight: 'bold' }}>🚨 Decryption Authorization Failed</div>
              {receiptId && <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>Receipt ID: {receiptId}</div>}
              <div>{error}</div>
              <div style={{ fontSize: '0.75rem', marginTop: 'var(--spacing-xs)', color: 'rgba(244, 63, 94, 0.8)' }}>
                Verification failed. The operator does not hold keys to decrypt this receipt.
              </div>
            </div>
          ) : receipt ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Receipt Identifier</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                  {receipt.id}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Associated Trade ID</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                  {receipt.completedTradeId}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Attestation Reference (T3)</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-accent)', wordBreak: 'break-all' }}>
                  {receipt.t3AttestationRef}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Key Version / Cryptographic Scheme</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-primary)' }}>
                  {receipt.keyVersion}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Cryptographic Hash</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                  {receipt.receiptHash}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="form-label">Enclave Envelope Ciphertext</span>
                <div 
                  style={{ 
                    fontFamily: 'var(--font-mono)', 
                    fontSize: '0.75rem', 
                    color: 'var(--color-success)',
                    background: 'var(--color-input-bg)',
                    padding: 'var(--spacing-md)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-border)',
                    maxHeight: '180px',
                    overflowY: 'auto',
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.4'
                  }}
                >
                  {receipt.receiptCiphertext}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: 'var(--spacing-xl)' }}>
              No receipt selected.
            </div>
          )}
        </div>

        <div className="drawer-footer">
          <button 
            type="button" 
            className="btn btn-primary" 
            onClick={onClose}
          >
            Acknowledge & Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default EncryptedReceiptDrawer;
