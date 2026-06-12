import { render, screen } from '@testing-library/react';
import { ProcessingStatusRail } from '../components/ProcessingStatusRail';
import type { ProcessingIntent } from '../hooks/useConnectionTelemetry';

describe('ProcessingStatusRail Component', () => {
  const mockIntents: ProcessingIntent[] = [
    {
      correlationRef: 'corr_test_123',
      agentDid: 'did:t3:test_agent_1',
      phase: 'intent_received',
      timestamp: new Date().toISOString(),
    },
    {
      correlationRef: 'corr_test_456',
      agentDid: 'did:t3:test_agent_2',
      phase: 'intent_sealed',
      timestamp: new Date().toISOString(),
    },
  ];

  it('renders the processing status rail with empty state when no events are active', () => {
    render(<ProcessingStatusRail intents={[]} />);
    
    expect(screen.getByText(/Secure event pipeline active/i)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for encrypted order signals/i)).toBeInTheDocument();
  });

  it('renders the processing status rail with active processing intents', () => {
    render(<ProcessingStatusRail intents={mockIntents} />);

    expect(screen.getByText(/Active Cryptographic Processing/i)).toBeInTheDocument();
    expect(screen.getByText(/corr_test_123/)).toBeInTheDocument();
    expect(screen.getByText(/corr_test_456/)).toBeInTheDocument();
    expect(screen.getByText(/Intent Sealed/i)).toBeInTheDocument();
    expect(screen.getByText(/Payload Blinded/i)).toBeInTheDocument();
  });

  it('contains absolutely no plaintext trading fields (asset, side, qty, price)', () => {
    const { container } = render(<ProcessingStatusRail intents={mockIntents} />);
    const htmlContent = container.innerHTML.toLowerCase();

    // Check with word boundaries or specific forbidden patterns
    const forbiddenPatterns = [
      /\basset\b/i,
      /\bside\b/i,
      /\bquantity\b/i,
      /\bprice\b/i,
      /\bbuy\b/i,
      /\bsell\b/i,
      /\bbtc\b/i,
      /\beth\b/i,
    ];
    
    forbiddenPatterns.forEach((pattern) => {
      expect(htmlContent).not.toMatch(pattern);
    });
  });
});
