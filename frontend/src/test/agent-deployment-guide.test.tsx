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
      listHostedAgents: vi.fn(),
      createHostedAgent: vi.fn(),
      startHostedAgent: vi.fn(),
      stopHostedAgent: vi.fn(),
    },
  };
});

const mockedListHostedAgents = vi.mocked(apiClient.listHostedAgents);

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
  });

  it('summarizes the active mandate in plain language', async () => {
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(screen.getByText('Configure Trading Mandate')).toBeInTheDocument();
    expect(screen.getByText('Mandate Live Summary')).toBeInTheDocument();
    expect(screen.getByText('Buy WBTC with USDC')).toBeInTheDocument();
    expect(screen.getByText('The agent will spend USDC to accumulate WBTC.')).toBeInTheDocument();
    expect(screen.getByText('70000 USDC per WBTC')).toBeInTheDocument();
    expect(screen.getByText('Live settlement enabled. Eligible matches can settle through the enclave.')).toBeInTheDocument();

    await waitFor(() => expect(mockedListHostedAgents).toHaveBeenCalled());
  });

  it('switches a preset into custom mode after an operator edit', async () => {
    const user = userEvent.setup();
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Distribute/i }));

    expect(screen.getByText('Sell WBTC for USDC')).toBeInTheDocument();
    expect(screen.getByText('Template loaded. Customizing any parameter below changes the mode to Custom.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Agent Label'), ' Desk');

    expect(screen.getByText('Custom configuration mode. Specify all rules manually.')).toBeInTheDocument();
  });

  it('reveals engine settings on the final wizard step', async () => {
    const user = userEvent.setup();
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(screen.queryByLabelText('LLM Engine')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Trading Instructions Prompt')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByLabelText('LLM Engine')).toBeInTheDocument();
    expect(screen.getByLabelText('Trading Instructions Prompt')).toBeInTheDocument();
  });
});
