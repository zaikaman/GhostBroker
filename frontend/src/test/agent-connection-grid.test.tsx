import { render, screen } from '@testing-library/react';
import { AgentConnectionGrid } from '../components/AgentConnectionGrid';
import type { AgentState } from '../hooks/useConnectionTelemetry';

describe('AgentConnectionGrid Component', () => {
  const mockAgents: AgentState[] = [
    {
      agentDid: 'did:t3:test_agent_verified_123',
      status: 'verified',
      connected: true,
      timestamp: '2026-06-12T17:00:00.000Z',
      authorityRef: 'auth:grant:123',
    },
    {
      agentDid: 'did:t3:test_agent_verifying_456',
      status: 'verifying',
      connected: false,
      timestamp: '2026-06-12T17:05:00.000Z',
    },
    {
      agentDid: 'did:t3:test_agent_rejected_789',
      status: 'rejected',
      connected: false,
      timestamp: '2026-06-12T17:10:00.000Z',
    },
  ];

  it('renders empty state when no agents are connected', () => {
    render(<AgentConnectionGrid agents={[]} />);
    expect(screen.getByText(/No agents currently onboarded or connecting/i)).toBeInTheDocument();
  });

  it('renders connection grid with agent cards and secure statuses', () => {
    render(<AgentConnectionGrid agents={mockAgents} />);

    // Check header
    expect(screen.getByText(/Active Enclave Agent Sessions \(3\)/i)).toBeInTheDocument();

    // Check online/offline indicators
    expect(screen.getByText(/ONLINE/i)).toBeInTheDocument();
    expect(screen.getAllByText(/OFFLINE/i).length).toBe(2);

    // Check status badges
    expect(screen.getByText(/Verified/i)).toBeInTheDocument();
    expect(screen.getByText(/Verifying/i)).toBeInTheDocument();
    expect(screen.getByText(/Rejected/i)).toBeInTheDocument();

    // Check truncated DIDs
    expect(screen.getByText(/did:t3:tes...ed_123/i)).toBeInTheDocument();
    expect(screen.getByText(/did:t3:tes...ng_456/i)).toBeInTheDocument();

    // Check authority reference
    expect(screen.getByText(/Auth Ref: auth:grant:123/i)).toBeInTheDocument();
  });

  it('contains absolutely no plaintext trading fields (asset, side, qty, price, queue)', () => {
    const { container } = render(<AgentConnectionGrid agents={mockAgents} />);
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
      /\bqueue\b/i,
    ];

    forbiddenPatterns.forEach((pattern) => {
      expect(htmlContent).not.toMatch(pattern);
    });
  });
});
