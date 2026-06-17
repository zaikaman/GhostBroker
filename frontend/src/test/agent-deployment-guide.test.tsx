import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDeploymentGuide } from '../components/AgentDeploymentGuide';
import { apiClient } from '../services/api-client';
import type * as ApiClientModule from '../services/api-client';

vi.mock('../services/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../services/api-client');
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      listHostedAgents: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      getInstitution: vi.fn().mockResolvedValue({
        id: 'institution-1',
        legalName: 'Blackridge Capital',
        displayName: 'Blackridge Capital',
        status: 'active',
        t3TenantDid: 'did:t3:blackridge',
        settlementProfileRef: 'noop',
      }),
      provisionAgent: vi.fn(),
      createHostedAgent: vi.fn(),
      startHostedAgent: vi.fn(),
      stopHostedAgent: vi.fn(),
      createNegotiationMandate: vi.fn(),
      listNegotiationMandates: vi.fn().mockResolvedValue([]),
    },
  };
});

const mockedListHostedAgents = vi.mocked(apiClient.listHostedAgents);
const mockedListAgents = vi.mocked(apiClient.listAgents);
const mockedGetInstitution = vi.mocked(apiClient.getInstitution);
const mockedProvisionAgent = vi.mocked(apiClient.provisionAgent);
const mockedListNegotiationMandates = vi.mocked(apiClient.listNegotiationMandates);

const session = {
  token: 'session-token',
  expiresAt: '2026-07-01T00:00:00.000Z',
  institution: {
    id: 'institution-1',
    displayName: 'Blackridge Capital',
    t3TenantDid: 'did:t3:blackridge',
  },
};

describe('AgentDeploymentGuide', () => {
  beforeEach(() => {
    mockedListHostedAgents.mockResolvedValue([]);
    mockedListAgents.mockResolvedValue([]);
    mockedGetInstitution.mockResolvedValue({
      id: 'institution-1',
      legalName: 'Blackridge Capital',
      displayName: 'Blackridge Capital',
      status: 'active',
      t3TenantDid: 'did:t3:blackridge',
      settlementProfileRef: 'noop',
    });
    mockedListNegotiationMandates.mockResolvedValue([]);
  });

  it('renders the mandate-bound deploy surface with a readiness checklist', async () => {
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(screen.getByText('Hosted Negotiator')).toBeInTheDocument();
    expect(screen.getByText('1. Select Admitted Agent')).toBeInTheDocument();
    expect(screen.getByText('2. Bound Negotiation Mandate')).toBeInTheDocument();
    expect(screen.getAllByText('No active mandate attached').length).toBeGreaterThanOrEqual(1);

    await waitFor(() => {
      expect(mockedListHostedAgents).toHaveBeenCalled();
      expect(mockedListAgents).toHaveBeenCalled();
    });
  });

  it('disables the launch button when no mandate is bound', async () => {
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Launch Hosted Negotiator/i })).toBeDisabled();
    });
  });

  it('shows a Provision Agent CTA when no admitted agents exist', async () => {
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(await screen.findByText('No admitted agent available')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Provision Agent/i }).length).toBeGreaterThan(0);
  });

  it('provisions a new agent inline and auto-selects it', async () => {
    const user = userEvent.setup();
    mockedProvisionAgent.mockResolvedValue({
      agent: {
        id: 'agent-2',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-2',
        status: 'admitted',
        authorityRef: 'authority-2',
        label: 'Inline Agent',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-2',
        metadata: { delegation_credential: { id: 'vc-2' } },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      admission: {
        id: 'agent-2',
        agentDid: 'did:t3:agent-2',
        status: 'admitted',
        authorityRef: 'authority-2',
      },
      policyHash: 'policy-2',
    });
    mockedListAgents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'agent-2',
          institutionId: 'institution-1',
          agentDid: 'did:t3:agent-2',
          status: 'admitted',
          authorityRef: 'authority-2',
          label: 'Inline Agent',
          instrumentScope: null,
          directionScope: null,
          maxNotional: null,
          limitReference: null,
          policyHash: 'policy-2',
          metadata: { delegation_credential: { id: 'vc-2' } },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await user.type(await screen.findByLabelText('Agent Label'), 'Inline Agent');
    const provisionButtons = screen.getAllByRole('button', { name: /Provision Agent/i });
    const primaryProvisionButton = provisionButtons[0];
    if (!primaryProvisionButton) {
      throw new Error('Provision button not found');
    }
    await user.click(primaryProvisionButton);

    await waitFor(() => {
      expect(mockedProvisionAgent).toHaveBeenCalled();
      expect(screen.getByRole('combobox', { name: '1. Select Admitted Agent' })).toHaveValue('agent-2');
    });
  });

  it('shows migration state for fleet agents that need a mandate', async () => {
    mockedListHostedAgents.mockResolvedValue([
      {
        agent: {
          id: 'agent-legacy-1',
          institutionId: 'institution-1',
          agentDid: 'did:t3:demo-legacy',
          status: 'admitted',
          authorityRef: 'legacy-auth',
          label: 'Legacy Bot',
          instrumentScope: null,
          directionScope: null,
          maxNotional: null,
          limitReference: null,
          policyHash: null,
          metadata: {},
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        config: null,
        runtime: {
          running: false,
          logTail: '',
        },
        mandate: null,
        migrationState: 'needs_migration',
      },
    ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('NEEDS MIGRATION')).toBeInTheDocument();
      expect(screen.getByText(/Legacy deploy config detected/i)).toBeInTheDocument();
    });
  });

  it('reveals advanced runtime settings when toggled', async () => {
    const user = userEvent.setup();
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(screen.queryByLabelText('Poll Interval (ms)')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show Advanced Runtime/i }));

    expect(screen.getByLabelText('Poll Interval (ms)')).toBeInTheDocument();
    expect(screen.getByLabelText('Max Ticks')).toBeInTheDocument();
    expect(screen.getByLabelText('Groq Model')).toBeInTheDocument();
    expect(screen.getByText('Dry Run')).toBeInTheDocument();
  });

  it('opens the mandate editor when Create Mandate is clicked', async () => {
    mockedListAgents.mockResolvedValue([
      {
        id: 'agent-1',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-1',
        status: 'admitted',
        authorityRef: 'authority-1',
        label: 'Agent One',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-1',
        metadata: { delegation_credential: { id: 'vc-1' } },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(await screen.findByLabelText('Asset')).toBeInTheDocument();
    expect(screen.getByLabelText('Side')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Reference Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Price Band (bps)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Mandate/i })).toBeInTheDocument();
  });

  it('shows mandate creation path immediately after provisioning', async () => {
    const user = userEvent.setup();
    mockedProvisionAgent.mockResolvedValue({
      agent: {
        id: 'agent-3',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-3',
        status: 'admitted',
        authorityRef: 'authority-3',
        label: 'Fresh Agent',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-3',
        metadata: { delegation_credential: { id: 'vc-3' } },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      admission: {
        id: 'agent-3',
        agentDid: 'did:t3:agent-3',
        status: 'admitted',
        authorityRef: 'authority-3',
      },
      policyHash: 'policy-3',
    });
    mockedListAgents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'agent-3',
          institutionId: 'institution-1',
          agentDid: 'did:t3:agent-3',
          status: 'admitted',
          authorityRef: 'authority-3',
          label: 'Fresh Agent',
          instrumentScope: null,
          directionScope: null,
          maxNotional: null,
          limitReference: null,
          policyHash: 'policy-3',
          metadata: { delegation_credential: { id: 'vc-3' } },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await user.type(await screen.findByLabelText('Agent Label'), 'Fresh Agent');
    const provisionButtons = screen.getAllByRole('button', { name: /Provision Agent/i });
    const primaryProvisionButton = provisionButtons[0];
    if (!primaryProvisionButton) {
      throw new Error('Provision button not found');
    }
    await user.click(primaryProvisionButton);

    await waitFor(() => {
      expect(screen.getByLabelText('Asset')).toBeInTheDocument();
      expect(screen.getAllByText('No active mandate attached').length).toBeGreaterThan(0);
    });
  });
});
