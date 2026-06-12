import { render, screen } from '@testing-library/react';
import { CompletedTradesTable } from '../components/CompletedTradesTable';
import { vi } from 'vitest';

describe('Completed Trades Empty State', () => {
  it('renders generic empty message when completed trades ledger is empty', () => {
    render(
      <CompletedTradesTable
        trades={[]}
        isLoading={false}
        onViewReceipt={vi.fn()}
      />
    );

    // Assert that the title shows trade history empty context
    expect(screen.getByText(/No completed trades recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/Secure connection active/i)).toBeInTheDocument();
  });

  it('contains absolutely no active queue language (e.g. queue, active order, no orders in queue, no pending orders)', () => {
    const { container } = render(
      <CompletedTradesTable
        trades={[]}
        isLoading={false}
        onViewReceipt={vi.fn()}
      />
    );

    const htmlContent = container.innerHTML.toLowerCase();
    
    // Check for active order book leakage wording
    const forbiddenPatterns = [
      /\border queue\b/i,
      /\bno active orders\b/i,
      /\bno orders in queue\b/i,
      /\bno pending orders\b/i,
      /\bactive order\b/i,
      /\bqueue empty\b/i,
    ];

    forbiddenPatterns.forEach((pattern) => {
      expect(htmlContent).not.toMatch(pattern);
    });
  });
});
