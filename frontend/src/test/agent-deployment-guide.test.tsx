import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDeploymentGuide } from '../components/AgentDeploymentGuide';
import { NegotiationMandateWrapper } from '../app/App';
import { apiClient } from '../services/api-client';
import { AGENTS_UPDATED_EVENT } from '../services/agent-events';
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

vi.mock('../components/MandateConfigForm', () => ({
  MandateConfigForm: ({ agentId }: { agentId: string }) => <div data-testid="mandate-form-agent">Mandate form for {agentId}</div>,
}));

const mockedListHostedAgents = vi.mocked(apiClient.listHostedAgents);
const mockedListAgents = vi.mocked(apiClient.listAgents);
const mockedGetInstitution = vi.mocked(apiClient.getInstitution);
const mockedProvisionAgent = vi.mocked(apiClient.provisionAgent);
const mockedListNegotiationMandates = vi.mocked(apiClient.listNegotiationMandates);
const mockedCreateNegotiationMandate = vi.mocked(apiClient.createNegotiationMandate);

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
    navigateMock.mockReset();
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
    mockedCreateNegotiationMandate.mockReset();
  });

  it('renders the deploy surface with section headers', async () => {
    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(screen.getByText('Hosted Negotiator')).toBeInTheDocument();
    expect(screen.getByText('Admitted Agent')).toBeInTheDocument();
    expect(screen.getByText('Mandate Bounds')).toBeInTheDocument();
    expect(screen.getByText('Runtime Settings')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockedListHostedAgents).toHaveBeenCalled();
      expect(mockedListAgents).toHaveBeenCalled();
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
      expect(screen.getByRole('combobox', { name: 'Select Admitted Agent', hidden: true })).toHaveValue('agent-2');
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

  it('shows runtime settings fields', async () => {
    const user = userEvent.setup();
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
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockedListNegotiationMandates.mockResolvedValue([
      {
        id: 'mandate-1',
        assetCode: 'WBTC',
        side: 'buy',
        targetQuantity: '2',
        referencePrice: '70000',
        priceBandBps: 150,
        maxNotional: '140000',
        urgency: 'normal',
        deadline: '2026-07-01T12:00:00.000Z',
        disclosableClaims: [],
        requiredCounterpartyClaims: {},
        counterpartyConstraints: {},
        operatorPrompt: 'Buy carefully.',
        policyHash: 'policy-1',
        objective: null,
        executionStyle: null,
        valuationPolicy: null,
        concessionPolicy: null,
        disclosurePolicy: null,
        approvalPolicy: null,
        counterpartyRequirements: null,
        sizePolicy: null,
        timeWindow: null,
        operatorInstructions: null,
        minimumQuantity: null,
        partialExecutionAllowed: null,
        derivedAnchorValue: null,
        derivedWalkawayMin: null,
        derivedWalkawayMax: null,
        derivedConcessionBudgetBps: null,
        derivedNotionalCeiling: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    // Navigate through steps to reach step 3 where runtime fields are visible
    await user.click(await screen.findByRole('button', { name: /Continue to Mandate Bounds/i }));
    await user.click(await screen.findByRole('button', { name: /Continue to Runtime Controls/i }));

    expect(screen.getByLabelText('Poll Interval (ms)')).toBeInTheDocument();
    expect(screen.getByLabelText('Max Ticks')).toBeInTheDocument();
    expect(screen.getByLabelText('Groq Model')).toBeInTheDocument();
    expect(screen.getByText('Dry Run')).toBeInTheDocument();
  });

  it('disables launch when runtime fields are not valid positive integers', async () => {
    const user = userEvent.setup();
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
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockedListNegotiationMandates.mockResolvedValue([
      {
        id: 'mandate-1',
        assetCode: 'WBTC',
        side: 'buy',
        targetQuantity: '2',
        referencePrice: '70000',
        priceBandBps: 150,
        maxNotional: '140000',
        urgency: 'normal',
        deadline: '2026-07-01T12:00:00.000Z',
        disclosableClaims: [],
        requiredCounterpartyClaims: {},
        counterpartyConstraints: {},
        operatorPrompt: 'Buy carefully.',
        policyHash: 'policy-1',
        objective: null,
        executionStyle: null,
        valuationPolicy: null,
        concessionPolicy: null,
        disclosurePolicy: null,
        approvalPolicy: null,
        counterpartyRequirements: null,
        sizePolicy: null,
        timeWindow: null,
        operatorInstructions: null,
        minimumQuantity: null,
        partialExecutionAllowed: null,
        derivedAnchorValue: null,
        derivedWalkawayMin: null,
        derivedWalkawayMax: null,
        derivedConcessionBudgetBps: null,
        derivedNotionalCeiling: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    // Navigate to step 3 where runtime fields and launch button are visible
    await user.click(await screen.findByRole('button', { name: /Continue to Mandate Bounds/i }));
    await user.click(await screen.findByRole('button', { name: /Continue to Runtime Controls/i }));

    const pollInput = screen.getByLabelText('Poll Interval (ms)');
    await user.clear(pollInput);
    await user.type(pollInput, '0');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Launch Hosted Negotiator/i })).toBeDisabled();
      expect(screen.getAllByText('Poll interval must be a positive integer.').length).toBeGreaterThan(0);
    });
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

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Continue to Mandate Bounds/i }));
    await user.click(await screen.findByRole('button', { name: /Create Mandate/i }));

    expect(await screen.findByLabelText('Asset')).toBeInTheDocument();
    expect(screen.getByLabelText('Side')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Reference Price (USD)')).toBeInTheDocument();
    expect(screen.getByLabelText('Price Tolerance (bps)')).toBeInTheDocument();
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

  it('keeps mandate selection scoped when switching between admitted agents', async () => {
    const user = userEvent.setup();
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
      {
        id: 'agent-2',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-2',
        status: 'admitted',
        authorityRef: 'authority-2',
        label: 'Agent Two',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-2',
        metadata: {},
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    mockedListNegotiationMandates.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-1') {
        return [
          {
            id: 'mandate-1',
            assetCode: 'WBTC',
            side: 'buy',
            targetQuantity: '2',
            referencePrice: '70000',
            priceBandBps: 150,
            maxNotional: '140000',
            urgency: 'normal',
            deadline: '2026-07-01T12:00:00.000Z',
            disclosableClaims: ['accredited_institution'],
            requiredCounterpartyClaims: { jurisdiction: 'US' },
            counterpartyConstraints: {},
            operatorPrompt: 'Buy carefully.',
            policyHash: 'policy-1',
            objective: null,
            executionStyle: null,
            valuationPolicy: null,
            concessionPolicy: null,
            disclosurePolicy: null,
            approvalPolicy: null,
            counterpartyRequirements: null,
            sizePolicy: null,
            timeWindow: null,
            operatorInstructions: null,
            minimumQuantity: null,
            partialExecutionAllowed: null,
            derivedAnchorValue: null,
            derivedWalkawayMin: null,
            derivedWalkawayMax: null,
            derivedConcessionBudgetBps: null,
            derivedNotionalCeiling: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-02T00:00:00.000Z',
          },
        ];
      }
      return [
        {
          id: 'mandate-2',
          assetCode: 'ETH',
          side: 'sell',
          targetQuantity: '5',
          referencePrice: '3500',
          priceBandBps: 120,
          maxNotional: '17500',
          urgency: 'high',
          deadline: '2026-07-02T12:00:00.000Z',
          disclosableClaims: ['settlement_capacity'],
          requiredCounterpartyClaims: { jurisdiction: 'GB' },
          counterpartyConstraints: { minimumFillPercent: 50 },
          operatorPrompt: 'Sell into qualified liquidity.',
          policyHash: 'policy-2',
          objective: null,
          executionStyle: null,
          valuationPolicy: null,
          concessionPolicy: null,
          disclosurePolicy: null,
          approvalPolicy: null,
          counterpartyRequirements: null,
          sizePolicy: null,
          timeWindow: null,
          operatorInstructions: null,
          minimumQuantity: null,
          partialExecutionAllowed: null,
          derivedAnchorValue: null,
          derivedWalkawayMin: null,
          derivedWalkawayMax: null,
          derivedConcessionBudgetBps: null,
          derivedNotionalCeiling: null,
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ];
    });

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    const agentSelect = await screen.findByRole('combobox', { name: 'Select Admitted Agent' });
    expect(agentSelect).toHaveValue('agent-1');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mandate Selection', hidden: true })).toHaveValue('mandate-1');
    });
    expect(screen.getAllByText('BUY WBTC').length).toBeGreaterThanOrEqual(1);

    await user.selectOptions(agentSelect, 'agent-2');

    await waitFor(() => {
      expect(agentSelect).toHaveValue('agent-2');
      expect(screen.getByRole('combobox', { name: 'Mandate Selection', hidden: true })).toHaveValue('mandate-2');
      expect(screen.getAllByText('SELL ETH').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('keeps the selected hosted record aligned when switching agents', async () => {
    const user = userEvent.setup();
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
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'agent-2',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-2',
        status: 'admitted',
        authorityRef: 'authority-2',
        label: 'Agent Two',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-2',
        metadata: {},
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    mockedListHostedAgents.mockResolvedValue([
      {
        agent: {
          id: 'agent-2',
          institutionId: 'institution-1',
          agentDid: 'did:t3:agent-2',
          status: 'admitted',
          authorityRef: 'authority-2',
          label: 'Agent Two',
          instrumentScope: null,
          directionScope: null,
          maxNotional: null,
          limitReference: null,
          policyHash: 'policy-2',
          metadata: {},
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        config: {
          mandateId: 'mandate-2',
          pollIntervalMs: 15000,
          maxTicks: 40,
          dryRun: false,
          groqModel: 'qwen/qwen3-32b',
        },
        runtime: {
          running: true,
          pid: 123,
          logTail: 'runtime online',
          startedAt: '2026-06-12T00:00:00.000Z',
        },
        mandate: {
          id: 'mandate-2',
          assetCode: 'ETH',
          side: 'sell',
          targetQuantity: '5',
          referencePrice: '3500',
          priceBandBps: 120,
          maxNotional: '17500',
          urgency: 'high',
          deadline: '2026-07-02T12:00:00.000Z',
          disclosableClaims: [],
          requiredCounterpartyClaims: {},
          counterpartyConstraints: {},
          operatorPrompt: 'Sell into qualified liquidity.',
          policyHash: 'policy-2',
          objective: null,
          executionStyle: null,
          valuationPolicy: null,
          concessionPolicy: null,
          disclosurePolicy: null,
          approvalPolicy: null,
          counterpartyRequirements: null,
          sizePolicy: null,
          timeWindow: null,
          operatorInstructions: null,
          minimumQuantity: null,
          partialExecutionAllowed: null,
          derivedAnchorValue: null,
          derivedWalkawayMin: null,
          derivedWalkawayMax: null,
          derivedConcessionBudgetBps: null,
          derivedNotionalCeiling: null,
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
        migrationState: 'ready',
      },
    ]);
    mockedListNegotiationMandates.mockImplementation(async (agentId: string) => {
      return agentId === 'agent-1'
        ? []
        : [
            {
              id: 'mandate-2',
              assetCode: 'ETH',
              side: 'sell',
              targetQuantity: '5',
              referencePrice: '3500',
              priceBandBps: 120,
              maxNotional: '17500',
              urgency: 'high',
              deadline: '2026-07-02T12:00:00.000Z',
              disclosableClaims: [],
              requiredCounterpartyClaims: {},
              counterpartyConstraints: {},
              operatorPrompt: 'Sell into qualified liquidity.',
              policyHash: 'policy-2',
              objective: null,
              executionStyle: null,
              valuationPolicy: null,
              concessionPolicy: null,
              disclosurePolicy: null,
              approvalPolicy: null,
              counterpartyRequirements: null,
              sizePolicy: null,
              timeWindow: null,
              operatorInstructions: null,
              minimumQuantity: null,
              partialExecutionAllowed: null,
              derivedAnchorValue: null,
              derivedWalkawayMin: null,
              derivedWalkawayMax: null,
              derivedConcessionBudgetBps: null,
              derivedNotionalCeiling: null,
              createdAt: '2026-06-03T00:00:00.000Z',
              updatedAt: '2026-06-04T00:00:00.000Z',
            },
          ];
    });

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    expect(await screen.findByText('runtime online')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Select Admitted Agent' }), 'agent-1');

    await waitFor(() => {
      expect(screen.getByText(/Selected agent does not have a hosted runtime yet/i)).toBeInTheDocument();
    });
  });

  it('reloads mandates for the current non-first agent after saving a replacement', async () => {
    const user = userEvent.setup();
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
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'agent-2',
        institutionId: 'institution-1',
        agentDid: 'did:t3:agent-2',
        status: 'admitted',
        authorityRef: 'authority-2',
        label: 'Agent Two',
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: 'policy-2',
        metadata: {},
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    mockedCreateNegotiationMandate.mockResolvedValue({
      mandate: { id: 'mandate-2b' },
      authorityRef: 'authority-2',
      policyHash: 'policy-2b',
    });
    let callCount = 0;
    mockedListNegotiationMandates.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-1') {
        return [];
      }
      callCount += 1;
      if (callCount < 2) {
        return [
          {
            id: 'mandate-2a',
            assetCode: 'ETH',
            side: 'sell',
            targetQuantity: '5',
            referencePrice: '3500',
            priceBandBps: 120,
            maxNotional: '17500',
            urgency: 'high',
            deadline: '2026-07-02T12:00:00.000Z',
            disclosableClaims: [],
            requiredCounterpartyClaims: {},
            counterpartyConstraints: {},
            operatorPrompt: 'Sell into qualified liquidity.',
            policyHash: 'policy-2a',
            objective: null,
            executionStyle: null,
            valuationPolicy: null,
            concessionPolicy: null,
            disclosurePolicy: null,
            approvalPolicy: null,
            counterpartyRequirements: null,
            sizePolicy: null,
            timeWindow: null,
            operatorInstructions: null,
            minimumQuantity: null,
            partialExecutionAllowed: null,
            derivedAnchorValue: null,
            derivedWalkawayMin: null,
            derivedWalkawayMax: null,
            derivedConcessionBudgetBps: null,
            derivedNotionalCeiling: null,
            createdAt: '2026-06-03T00:00:00.000Z',
            updatedAt: '2026-06-04T00:00:00.000Z',
          },
        ];
      }
      return [
        {
          id: 'mandate-2b',
          assetCode: 'ETH',
          side: 'sell',
          targetQuantity: '6',
          referencePrice: '3550',
          priceBandBps: 120,
          maxNotional: '21300',
          urgency: 'high',
          deadline: '2026-07-03T12:00:00.000Z',
          disclosableClaims: [],
          requiredCounterpartyClaims: {},
          counterpartyConstraints: {},
          operatorPrompt: 'Updated sell mandate.',
          policyHash: 'policy-2b',
          objective: null,
          executionStyle: null,
          valuationPolicy: null,
          concessionPolicy: null,
          disclosurePolicy: null,
          approvalPolicy: null,
          counterpartyRequirements: null,
          sizePolicy: null,
          timeWindow: null,
          operatorInstructions: null,
          minimumQuantity: null,
          partialExecutionAllowed: null,
          derivedAnchorValue: null,
          derivedWalkawayMin: null,
          derivedWalkawayMax: null,
          derivedConcessionBudgetBps: null,
          derivedNotionalCeiling: null,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-06T00:00:00.000Z',
        },
      ];
    });

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Select Admitted Agent' }), 'agent-2');
    await user.click(await screen.findByRole('button', { name: /Continue to Mandate Bounds/i }));
    await user.click(await screen.findByRole('button', { name: /Edit \/ Replace Mandate/i }));
    const targetQuantity = await screen.findByLabelText('Target Quantity');
    await user.clear(targetQuantity);
    await user.type(targetQuantity, '6');
    await user.click(screen.getByRole('button', { name: /Save Mandate/i }));

    await waitFor(() => {
      expect(mockedCreateNegotiationMandate).toHaveBeenCalledWith(
        'agent-2',
        expect.objectContaining({ targetQuantity: 6 }),
      );
      // After save, step advances to 3 where mandate select is hidden, so use hidden: true
      expect(screen.getByRole('combobox', { name: 'Mandate Selection', hidden: true })).toHaveValue('mandate-2b');
    });
  });

  it('requires valid structured mandate values before saving', async () => {
    const user = userEvent.setup();
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
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(<AgentDeploymentGuide session={session} onBack={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Continue to Mandate Bounds/i }));
    await user.click(await screen.findByRole('button', { name: /Create Mandate/i }));

    const targetQuantity = await screen.findByLabelText('Target Quantity');
    await user.clear(targetQuantity);
    await user.type(targetQuantity, '0');
    await user.click(screen.getByRole('button', { name: /Save Mandate/i }));

    await waitFor(() => {
      expect(screen.getAllByText('Target quantity must be greater than zero.').length).toBeGreaterThan(0);
      expect(mockedCreateNegotiationMandate).not.toHaveBeenCalled();
    });
  });
});

describe('NegotiationMandateWrapper', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    mockedListAgents.mockReset();
  });

  it('requires an explicit agent selection when multiple admitted agents exist', async () => {
    const user = userEvent.setup();
    mockedListAgents.mockResolvedValue([
      { id: 'agent-1', institutionId: 'institution-1', agentDid: 'did:t3:agent-1', status: 'admitted', authorityRef: 'authority-1', label: 'Agent One', instrumentScope: null, directionScope: null, maxNotional: null, limitReference: null, policyHash: null, metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'agent-2', institutionId: 'institution-1', agentDid: 'did:t3:agent-2', status: 'admitted', authorityRef: 'authority-2', label: 'Agent Two', instrumentScope: null, directionScope: null, maxNotional: null, limitReference: null, policyHash: null, metadata: {}, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);

    render(<NegotiationMandateWrapper />);

    expect(await screen.findByText('MANDATE TARGETING')).toBeInTheDocument();
    expect(screen.getByText('Select an admitted agent to edit its negotiation mandate.')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Admitted Agent' }), 'agent-2');

    await waitFor(() => {
      expect(screen.getByTestId('mandate-form-agent')).toHaveTextContent('Mandate form for agent-2');
    });
  });

  it('refreshes admitted agents when the shared agent update event fires', async () => {
    mockedListAgents
      .mockResolvedValueOnce([
        { id: 'agent-1', institutionId: 'institution-1', agentDid: 'did:t3:agent-1', status: 'admitted', authorityRef: 'authority-1', label: 'Agent One', instrumentScope: null, directionScope: null, maxNotional: null, limitReference: null, policyHash: null, metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([
        { id: 'agent-1', institutionId: 'institution-1', agentDid: 'did:t3:agent-1', status: 'admitted', authorityRef: 'authority-1', label: 'Agent One', instrumentScope: null, directionScope: null, maxNotional: null, limitReference: null, policyHash: null, metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'agent-2', institutionId: 'institution-1', agentDid: 'did:t3:agent-2', status: 'admitted', authorityRef: 'authority-2', label: 'Agent Two', instrumentScope: null, directionScope: null, maxNotional: null, limitReference: null, policyHash: null, metadata: {}, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      ]);

    render(<NegotiationMandateWrapper />);

    expect(await screen.findByRole('combobox', { name: 'Admitted Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Agent Two' })).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AGENTS_UPDATED_EVENT));

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Agent Two' })).toBeInTheDocument();
    });
  });
});
