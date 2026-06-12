import { render, screen } from '@testing-library/react';
import { LiveAgentActivityStream } from '../components/LiveAgentActivityStream';
import type { AgentState, ProcessingIntent } from '../hooks/useConnectionTelemetry';
import { vi } from 'vitest';

// Mock the telemetry client to prevent WebSocket interference in unit tests
vi.mock('../services/telemetry-client', () => ({
  telemetryClient: {
    onMessage: vi.fn(() => () => undefined),
  },
}));

describe('LiveAgentActivityStream Component', () => {
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
      phase: 'intent_sealed',
      timestamp: new Date().toISOString(),
    },
  ];

  it('renders the stream in empty state when no agents are connected', () => {
    render(
      <LiveAgentActivityStream
        agents={[]}
        intents={[]}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );

    expect(screen.getByText(/Awaiting agent connections.../i)).toBeInTheDocument();
    expect(
      screen.getByText(/The enclave is ready. Agents will appear here once they authenticate./i)
    ).toBeInTheDocument();
  });

  it('renders agent log entries, headers, and center column timeline when agents/intents are active', () => {
    render(
      <LiveAgentActivityStream
        agents={mockAgents}
        intents={mockIntents}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );

    // Verify pane titles
    expect(screen.getByText(/BUYER AGENT LOGS \(JPMorgan\)/)).toBeInTheDocument();
    expect(screen.getByText(/SELLER AGENT LOGS \(Goldman Sachs\)/)).toBeInTheDocument();

    // Verify center column title
    expect(screen.getByText(/GhostBroker TEE/i)).toBeInTheDocument();

    // Verify mapped log messages are rendered
    expect(screen.getByText('✅ Session verified.')).toBeInTheDocument();
    expect(screen.getByText('🔑 Session Verified')).toBeInTheDocument();
    expect(screen.getByText('📥 Mandate received.')).toBeInTheDocument();
    expect(screen.getByText('📦 Order payload blinded.')).toBeInTheDocument();
  });

  it('truncates all agent DIDs and never renders them in full', () => {
    const { container } = render(
      <LiveAgentActivityStream
        agents={mockAgents}
        intents={mockIntents}
        institutionName={mockInstitutionName}
        institutionDid={mockInstitutionDid}
      />
    );

    const leftDid = mockAgents[0]?.agentDid || '';
    const rightDid = mockAgents[1]?.agentDid || '';

    // Verify that the full DIDs are NOT present in the DOM
    expect(container.innerHTML).not.toContain(leftDid);
    expect(container.innerHTML).not.toContain(rightDid);

    // Verify that truncated versions are present
    const truncatedLeft = `${leftDid.slice(0, 10)}...${leftDid.slice(-6)}`;
    const truncatedRight = `${rightDid.slice(0, 10)}...${rightDid.slice(-6)}`;

    expect(screen.getAllByText(new RegExp(truncatedLeft.replace(/\./g, '\\.'), 'i')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(truncatedRight.replace(/\./g, '\\.'), 'i')).length).toBeGreaterThan(0);
  });

  it('contains absolutely no plaintext trading fields (asset, side, qty, price, asset names)', () => {
    const { container } = render(
      <LiveAgentActivityStream
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
