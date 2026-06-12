import { render, screen, fireEvent } from '@testing-library/react';
import { EncryptedReceiptDrawer } from '../components/EncryptedReceiptDrawer';
import { buildMockAuditReceipt } from './dashboard-test-data';
import { vi } from 'vitest';

describe('EncryptedReceiptDrawer Component', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    mockOnClose.mockClear();
  });

  it('renders nothing selected when receiptId is null and not open', () => {
    render(
      <EncryptedReceiptDrawer
        receiptId={null}
        isOpen={false}
        onClose={mockOnClose}
        receipt={null}
        isLoading={false}
        error={null}
      />
    );
    
    expect(screen.getByText(/No receipt selected/i)).toBeInTheDocument();
  });

  it('renders loading view correctly', () => {
    render(
      <EncryptedReceiptDrawer
        receiptId="receipt_123"
        isOpen={true}
        onClose={mockOnClose}
        receipt={null}
        isLoading={true}
        error={null}
      />
    );

    expect(screen.getByText(/Decrypting enclave audit reference.../i)).toBeInTheDocument();
  });

  it('renders authorization error view correctly', () => {
    render(
      <EncryptedReceiptDrawer
        receiptId="receipt_123"
        isOpen={true}
        onClose={mockOnClose}
        receipt={null}
        isLoading={false}
        error="Access denied: unauthorized operator"
      />
    );

    expect(screen.getByText(/Decryption Authorization Failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Receipt ID: receipt_123/i)).toBeInTheDocument();
    expect(screen.getByText(/Access denied: unauthorized operator/i)).toBeInTheDocument();
  });

  it('renders successful receipt details correctly', () => {
    const mockReceipt = buildMockAuditReceipt({
      id: 'receipt_id_val',
      completedTradeId: 'trade_id_val',
      t3AttestationRef: 'attestation_val',
      keyVersion: 'key-v3',
      receiptHash: 'hash_val',
      receiptCiphertext: 'raw_ciphertext_val',
    });

    render(
      <EncryptedReceiptDrawer
        receiptId="receipt_id_val"
        isOpen={true}
        onClose={mockOnClose}
        receipt={mockReceipt}
        isLoading={false}
        error={null}
      />
    );

    expect(screen.getByText('receipt_id_val')).toBeInTheDocument();
    expect(screen.getByText('trade_id_val')).toBeInTheDocument();
    expect(screen.getByText('attestation_val')).toBeInTheDocument();
    expect(screen.getByText('key-v3')).toBeInTheDocument();
    expect(screen.getByText('hash_val')).toBeInTheDocument();
    expect(screen.getByText('raw_ciphertext_val')).toBeInTheDocument();
  });

  it('triggers onClose when close button is clicked', () => {
    render(
      <EncryptedReceiptDrawer
        receiptId="receipt_123"
        isOpen={true}
        onClose={mockOnClose}
        receipt={null}
        isLoading={false}
        error={null}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /close audit receipt drawer/i });
    fireEvent.click(closeBtn);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('triggers onClose when Esc key is pressed', () => {
    render(
      <EncryptedReceiptDrawer
        receiptId="receipt_123"
        isOpen={true}
        onClose={mockOnClose}
        receipt={null}
        isLoading={false}
        error={null}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});
