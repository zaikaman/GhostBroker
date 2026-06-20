import { render, screen } from '@testing-library/react';
import { TeeNegotiationVisualizer } from '../components/TeeNegotiationVisualizer';
import type { AgentState, ProcessingIntent } from '../hooks/useConnectionTelemetry';

describe('TeeNegotiationVisualizer Component', () => {
  const mockInstitutionName = 'JPMorgan';
  const mockInstitutionDid = 'did:t3:jpmorgan_tenant_1234567890abcdef';

  const mockAgents: AgentState[] = [
    {
      agentDid: 'did:t3:jpmorgan_tenant_1234567890abcdef',
      status: 'verified',
      connected: true,
      timestamp: new Date().toISOString(),
    },
    {
      agentDid: 'did:t3:goldmansachs_tenant_9876543210fedcba',
      status: 'verifying',
      connected: true,
      timestamp: new Date().toISOString(),
    },
  ];

  const mockIntents: ProcessingIntent[] = [
    {
      correlationRef: 'corr_test_111',
      agentDid: 'did:t3:jpmorgan_tenant_1234567890abcdef',
      phase: 'intent_received',
      timestamp: new Date().toISOString(),
    },
    {
      correlationRef: 'corr_test_222',
      agentDid: 'did:t3:goldmansachs_tenant_9876543210fedcba',
      phase: 'negotiation_ticket_sealed',
      timestamp: new Date().toISOString(),
    },
  ];

  it('renders in empty state when no agents are connected', () => {
    render(
      <TeeNegotiationVisualizer
        agents={[]}
        intents={[]}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );

    expect(screen.getByText(/Awaiting agent connections.../i)).toBeInTheDocument();
  });

  it('renders agent labels and pipeline steps when active', () => {
    render(
      <TeeNegotiationVisualizer
        agents={mockAgents}
        intents={mockIntents}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );

    // Verify institution names/labels — local institution's name
    // is shown for the LOCAL pane, counterparty side is an
    // opaque DID-derived handle (never a real institution name).
    expect(screen.getAllByText(mockInstitutionName).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Counterparty \(did:t3:g\)/i).length).toBeGreaterThan(0);

    // Verify pipeline stages
    expect(screen.getByText('Attest')).toBeInTheDocument();
    expect(screen.getByText('Blind')).toBeInTheDocument();
    expect(screen.getByText('Pair')).toBeInTheDocument();
    expect(screen.getByText('Negotiate')).toBeInTheDocument();
    expect(screen.getByText('Settle')).toBeInTheDocument();
    expect(screen.getByText('Purge')).toBeInTheDocument();
  });

  it('contains absolutely no plaintext trading fields (asset, side, qty, price, asset names)', () => {
    const { container } = render(
      <TeeNegotiationVisualizer
        agents={mockAgents}
        intents={mockIntents}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );
    const htmlContent = container.innerHTML.toLowerCase();

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
