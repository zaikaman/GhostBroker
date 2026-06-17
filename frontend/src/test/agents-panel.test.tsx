import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPanel } from '../components/AgentsPanel';
import { apiClient } from '../services/api-client';
import type * as ApiClientModule from '../services/api-client';

const navigateMock = vi.fn();

vi.mock('../app/use-router', () => ({
  useRouter: () => ({ currentPath: '/dashboard', navigate: navigateMock }),
}));

vi.mock('../services/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../services/api-client');
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      listAgents: vi.fn(),
      updateAgentLabel: vi.fn(),
      revokeAgent: vi.fn(),
    },
  };
});

const mockedListAgents = vi.mocked(apiClient.listAgents);

describe('AgentsPanel', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    mockedListAgents.mockResolvedValue([]);
  });

  it('offers provisioning instead of circular hosted-agent guidance in the empty state', async () => {
    const user = userEvent.setup();
    render(<AgentsPanel />);

    expect(await screen.findByText('No agents provisioned yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Provision Agent/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Provision Agent/i }));

    expect(navigateMock).toHaveBeenCalledWith('/deploy');
  });

  it('shows admitted lifecycle status even when delegation metadata is missing', async () => {
    mockedListAgents.mockResolvedValue([
      {
        id: 'agent-1',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-1',
        status: 'admitted',
        authorityRef: 'authority-1',
        label: 'Configured Agent',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-1',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText('ADMITTED')).toBeInTheDocument();
    });
  });

  it('adds a delegated badge when delegation metadata is present', async () => {
    mockedListAgents.mockResolvedValue([
      {
        id: 'agent-1',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-1',
        status: 'admitted',
        authorityRef: 'authority-1',
        label: 'Delegated Agent',
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

    render(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText('DELEGATED')).toBeInTheDocument();
    });
  });

  it('adds a hosted badge when hosted negotiator metadata is present', async () => {
    mockedListAgents.mockResolvedValue([
      {
        id: 'agent-1',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-1',
        status: 'admitted',
        authorityRef: 'authority-1',
        label: 'Hosted Agent',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-1',
        metadata: {
          hostedAgent: { mandateId: 'mandate-1', pollIntervalMs: 15000, maxTicks: 40, dryRun: false },
          hostedNegotiator: { migrationState: 'ready' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText('HOSTED')).toBeInTheDocument();
    });
  });
});
