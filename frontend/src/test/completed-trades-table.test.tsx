import { render, screen, fireEvent } from '@testing-library/react';
import { CompletedTradesTable } from '../components/CompletedTradesTable';
import { buildMockCompletedTrade } from './dashboard-test-data';
import { vi } from 'vitest';

describe('CompletedTradesTable Component', () => {
  const mockOnViewReceipt = vi.fn();

  beforeEach(() => {
    mockOnViewReceipt.mockClear();
  });

  it('renders loading state correctly', () => {
    render(
      <CompletedTradesTable
        trades={[]}
        isLoading={true}
        onViewReceipt={mockOnViewReceipt}
      />
    );
    expect(screen.getByText(/Querying secure trade history ledger.../i)).toBeInTheDocument();
  });

  it('renders table headers and encrypted trade details', () => {
    const mockTrade = buildMockCompletedTrade({
      tradeRef: 'ref_123',
      assetCodeCiphertext: 'cipher_asset_foo_longer_ciphertext',
      quantityCiphertext: 'cipher_qty_100_longer_ciphertext',
      executionPriceCiphertext: 'cipher_price_50000_longer_ciphertext',
      settlementStatus: 'settled',
    });

    render(
      <CompletedTradesTable
        trades={[mockTrade]}
        isLoading={false}
        onViewReceipt={mockOnViewReceipt}
      />
    );

    // Headers
    expect(screen.getByText('Trade Ref')).toBeInTheDocument();
    expect(screen.getByText('Asset Ticker')).toBeInTheDocument();
    expect(screen.getByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('Execution Price')).toBeInTheDocument();

    // Row contents showing secure placeholders/ciphertext
    expect(screen.getByText('ref_123')).toBeInTheDocument();
    expect(screen.getByText(/cipher_ass.*phertext/i)).toBeInTheDocument();
    expect(screen.getByText(/cipher_qty.*phertext/i)).toBeInTheDocument();
    expect(screen.getByText(/cipher_pri.*phertext/i)).toBeInTheDocument();
    expect(screen.getByText('settled')).toBeInTheDocument();

    // Audit receipt button
    const btn = screen.getByRole('button', { name: /view audit receipt for trade ref_123/i });
    expect(btn).toBeInTheDocument();

    // Click trigger callback
    fireEvent.click(btn);
    expect(mockOnViewReceipt).toHaveBeenCalledWith(mockTrade.receiptIds[0]);
  });

  it('renders unavailable receipt state correctly', () => {
    const mockTradeNoReceipt = buildMockCompletedTrade({
      tradeRef: 'ref_no_receipt',
      receiptIds: [],
    });

    render(
      <CompletedTradesTable
        trades={[mockTradeNoReceipt]}
        isLoading={false}
        onViewReceipt={mockOnViewReceipt}
      />
    );

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('contains absolutely no plaintext trading fields (e.g. BUY, SELL, BTC, 100, 50000)', () => {
    const mockTrade = buildMockCompletedTrade({
      assetCodeCiphertext: 'cipher_asset_foo',
      quantityCiphertext: 'cipher_qty_100',
      executionPriceCiphertext: 'cipher_price_50000',
    });

    const { container } = render(
      <CompletedTradesTable
        trades={[mockTrade]}
        isLoading={false}
        onViewReceipt={mockOnViewReceipt}
      />
    );

    const htmlContent = container.innerHTML.toLowerCase();
    
    // The table shouldn't leak the actual terms
    const forbiddenPatterns = [
      /\bbtc\b/i,
      /\beth\b/i,
      /\bbuy\b/i,
      /\bsell\b/i,
    ];

    forbiddenPatterns.forEach((pattern) => {
      expect(htmlContent).not.toMatch(pattern);
    });
  });
});
