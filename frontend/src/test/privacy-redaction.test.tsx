import { render, screen } from '@testing-library/react';
import App from '../app/App';

describe('Frontend Privacy Redaction', () => {
  const FORBIDDEN_WORDS = [
    'asset_code',
    'bid_price',
    'ask_price',
    'queue_depth',
    'queue_rank',
    'order_count',
  ];

  // Specific labels/indicators that leak active order queue details or peer identities
  const PRIVACY_REGRESSION_LABELS = [
    'queue depth',
    'queue rank',
    'queue size',
    'queue count',
    'counterparty',
    'peer',
    'bid price',
    'ask price',
  ];

  it('should not contain any forbidden active order leakage terms or text', () => {
    const { container } = render(<App />);
    const htmlContent = container.innerHTML.toLowerCase();

    // Verify no forbidden terms leak into the DOM
    FORBIDDEN_WORDS.forEach((word) => {
      expect(htmlContent).not.toContain(word.toLowerCase());
    });
  });

  it('should block active queue, price, quantity, and counterparty labels in active areas', () => {
    const { container } = render(<App />);
    const htmlContent = container.innerHTML.toLowerCase();

    PRIVACY_REGRESSION_LABELS.forEach((label) => {
      expect(htmlContent).not.toContain(label.toLowerCase());
    });
  });

  it('should render the secure enclave disclaimer indicating zero visibility for active orders', () => {
    render(<App />);
    
    // The disclaimer from DESIGN.md must be fully rendered
    expect(
      screen.getByText(/Order queue is cryptographically secured inside hardware TEE. Zero visibility mode active./i)
    ).toBeInTheDocument();
  });
});
