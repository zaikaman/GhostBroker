import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiClient,
  type Agent,
  type AuthSession,
  type CreateHostedAgentRequest,
  type HostedAgentRecord,
  type Institution,
  type NegotiationMandateSummary,
  type RelayerApprovalResponse,
} from '../services/api-client';
import {
  Activity01Icon,
  AlertCircleIcon,
  ArrowLeft01Icon,
  Copy01Icon,
  Loading03Icon,
  PlayIcon,
  Refresh01Icon,
  RocketIcon,
  Shield01Icon,
  StopIcon,
} from 'hugeicons-react';
import { AgentProvisioningForm } from './AgentProvisioningForm';
import { MandateConfigForm } from './MandateConfigForm';
import '../styles/deploy.css';
import { dispatchAgentsUpdated } from '../services/agent-events';

interface AgentDeploymentGuideProps {
  session: AuthSession;
  onBack: () => void;
}

interface RuntimeFormState {
  pollIntervalMs: string;
  maxTicks: string;
  dryRun: boolean;
  groqModel: string;
}

const defaultRuntimeForm: RuntimeFormState = {
  pollIntervalMs: '15000',
  maxTicks: '40',
  dryRun: false,
  groqModel: 'qwen/qwen3-32b',
};

function formatTimestamp(value?: string): string {
  if (!value) return 'Not started';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateMiddle(value: string, keep = 12): string {
  if (value.length <= keep * 2) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function humanizeExecutionStyle(style: NegotiationMandateSummary['executionStyle']): string {
  if (!style) return '—';
  return style.replace(/_/gu, ' ').replace(/\b\w/gu, (c) => c.toUpperCase());
}

/**
 * Summarize the bound mandate from the authored AI-first fields when
 * present, falling back to the legacy derived columns for older
 * mandates. Surfaces policy intent, not trader-style numbers.
 */
function summarizeMandate(mandate: NegotiationMandateSummary | null): Array<{ label: string; value: string }> {
  if (!mandate) {
    return [
      { label: 'State', value: 'No active mandate attached' },
      { label: 'Action', value: 'Author a negotiation policy before launch' },
    ];
  }

  const objective = mandate.objective
    ? mandate.objective.length > 60
      ? `${mandate.objective.slice(0, 60)}…`
      : mandate.objective
    : mandate.operatorPrompt
      ? (mandate.operatorPrompt.length > 60 ? `${mandate.operatorPrompt.slice(0, 60)}…` : mandate.operatorPrompt)
      : '—';

  return [
    { label: 'Objective', value: objective },
    { label: 'Side', value: mandate.side.toUpperCase() },
    { label: 'Asset', value: mandate.assetCode },
    { label: 'Target Size', value: mandate.targetQuantity },
    { label: 'Execution Posture', value: mandate.executionStyle ? humanizeExecutionStyle(mandate.executionStyle) : '—' },
    { label: 'Urgency', value: mandate.urgency.toUpperCase() },
    { label: 'Deadline', value: new Date(mandate.deadline).toLocaleString() },
  ];
}

export function AgentDeploymentGuide({ session, onBack }: AgentDeploymentGuideProps): React.JSX.Element {
  const [hostedAgents, setHostedAgents] = useState<HostedAgentRecord[]>([]);
  const [admittedAgents, setAdmittedAgents] = useState<Agent[]>([]);
  const [mandatesByAgentId, setMandatesByAgentId] = useState<Record<string, NegotiationMandateSummary[]>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedMandateId, setSelectedMandateId] = useState<string>('');
  const [runtimeForm, setRuntimeForm] = useState<RuntimeFormState>(defaultRuntimeForm);
  const [showMandateEditor, setShowMandateEditor] = useState(false);
  const [showProvisioningForm, setShowProvisioningForm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [depositStatus, setDepositStatus] = useState<RelayerApprovalResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mandateValidationError, setMandateValidationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeStep, setActiveStep] = useState<number>(1);

  const loadState = useCallback(async (preferredAgentId?: string | null) => {
    const [records, agents, inst] = await Promise.all([
      apiClient.listHostedAgents(),
      apiClient.listAgents('admitted'),
      apiClient.getInstitution(session.institution.id),
    ]);
    const mandateEntries = await Promise.all(
      agents.map(async (agent) => [agent.id, await apiClient.listNegotiationMandates(agent.id)] as const),
    );
    const nextMandatesByAgentId = Object.fromEntries(mandateEntries);

    setHostedAgents(records);
    setAdmittedAgents(agents);
    setMandatesByAgentId(nextMandatesByAgentId);
    setInstitution(inst);

    if (inst.settlementProfileRef === 'chain:sepolia:erc20') {
      try {
        setDepositStatus(await apiClient.getDepositStatus(inst.id));
      } catch {
        setDepositStatus(null);
      }
    } else {
      setDepositStatus(null);
    }

    setSelectedAgentId((current) => {
      if (preferredAgentId && agents.some((agent) => agent.id === preferredAgentId)) {
        return preferredAgentId;
      }
      if (current && agents.some((agent) => agent.id === current)) {
        return current;
      }
      return records[0]?.agent.id ?? agents[0]?.id ?? null;
    });
  }, [session.institution.id]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadState()
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Failed to load hosted negotiator state.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoading(false);
          }
        });
    });

    const intervalId = window.setInterval(() => {
      loadState().catch(() => undefined);
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadState]);

  const selectedHostedRecord = useMemo(
    () => hostedAgents.find((record) => record.agent.id === selectedAgentId) ?? null,
    [hostedAgents, selectedAgentId],
  );

  const selectedAgent = useMemo(
    () => admittedAgents.find((agent) => agent.id === selectedAgentId) ?? selectedHostedRecord?.agent ?? null,
    [admittedAgents, selectedAgentId, selectedHostedRecord],
  );

  const selectedAgentMandates = useMemo(
    () => (selectedAgentId ? (mandatesByAgentId[selectedAgentId] ?? []) : []),
    [mandatesByAgentId, selectedAgentId],
  );

  const selectedMandate = useMemo(
    () => selectedAgentMandates.find((mandate) => mandate.id === selectedMandateId)
      ?? selectedHostedRecord?.mandate
      ?? selectedAgentMandates[0]
      ?? null,
    [selectedAgentMandates, selectedHostedRecord, selectedMandateId],
  );

  useEffect(() => {
    if (selectedHostedRecord?.config?.mandateId) {
      setSelectedMandateId(selectedHostedRecord.config.mandateId);
      return;
    }
    if (selectedAgentMandates[0]?.id) {
      const firstMandate = selectedAgentMandates[0];
      if (firstMandate) {
        setSelectedMandateId((current) => current || firstMandate.id);
      }
      return;
    }
    if (selectedMandate?.id) {
      setSelectedMandateId(selectedMandate.id);
      return;
    }
    setSelectedMandateId('');
  }, [selectedAgentMandates, selectedHostedRecord, selectedMandate]);

  useEffect(() => {
    if (!selectedAgentId) {
      setSelectedMandateId('');
      return;
    }
    const mandates = mandatesByAgentId[selectedAgentId] ?? [];
    if (mandates.length === 0) {
      setSelectedMandateId('');
      return;
    }
    if (!mandates.some((mandate) => mandate.id === selectedMandateId)) {
      const firstMandate = mandates[0];
      if (firstMandate) {
        setSelectedMandateId(firstMandate.id);
      }
    }
  }, [mandatesByAgentId, selectedAgentId, selectedMandateId]);

  useEffect(() => {
    if (selectedHostedRecord?.config) {
      setRuntimeForm({
        pollIntervalMs: String(selectedHostedRecord.config.pollIntervalMs),
        maxTicks: String(selectedHostedRecord.config.maxTicks),
        dryRun: selectedHostedRecord.config.dryRun,
        groqModel: selectedHostedRecord.config.groqModel ?? defaultRuntimeForm.groqModel,
      });
    }
  }, [selectedHostedRecord]);

  const runningCount = hostedAgents.filter((record) => record.runtime.running).length;
  const isChainRail = institution?.settlementProfileRef === 'chain:sepolia:erc20';
  const settlementReady = isChainRail ? Boolean(depositStatus?.approved.wbtc && depositStatus?.approved.usdc) : true;
  const runtimeValidationMessage = useMemo(() => {
    if (!isPositiveInteger(runtimeForm.pollIntervalMs)) return 'Poll interval must be a positive integer.';
    if (!isPositiveInteger(runtimeForm.maxTicks)) return 'Max ticks must be a positive integer.';
    return null;
  }, [runtimeForm.pollIntervalMs, runtimeForm.maxTicks]);
  const canLaunch = Boolean(selectedAgentId && selectedMandateId) && settlementReady && !runtimeValidationMessage;
  const hasAdmittedAgents = admittedAgents.length > 0;
  const hasHostedAgents = hostedAgents.length > 0;
  const selectedAgentHasHostedRuntime = useMemo(
    () => hostedAgents.some((record) => record.agent.id === selectedAgentId),
    [hostedAgents, selectedAgentId],
  );

  const handleProvisioned = useCallback(async (agent: Agent) => {
    setShowProvisioningForm(false);
    setShowMandateEditor(true);
    await loadState(agent.id);
    dispatchAgentsUpdated();
    setActiveStep(2);
  }, [loadState]);

  /**
   * After the MandateConfigForm (an authored policy form) commits a
   * mandate successfully, reload state, bind the new mandate, and
   * advance to runtime controls. Validation lives in the form itself.
   */
  const handleMandateCommitted = useCallback(async () => {
    if (!selectedAgentId) return;
    setShowMandateEditor(false);
    setMandateValidationError(null);
    await loadState(selectedAgentId);
    setActiveStep(3);
  }, [loadState, selectedAgentId]);

  const handleLaunch = useCallback(async () => {
    if (!selectedAgentId) {
      setError('Select an admitted agent before launching.');
      return;
    }
    if (!selectedMandateId) {
      setError('Attach a negotiation mandate before launching.');
      return;
    }
    if (runtimeValidationMessage) {
      setError(runtimeValidationMessage);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const request: CreateHostedAgentRequest = {
        institutionId: session.institution.id,
        agentId: selectedAgentId,
        config: {
          mandateId: selectedMandateId,
          pollIntervalMs: Number(runtimeForm.pollIntervalMs),
          maxTicks: Number(runtimeForm.maxTicks),
          dryRun: runtimeForm.dryRun,
          ...(runtimeForm.groqModel.trim() ? { groqModel: runtimeForm.groqModel.trim() } : {}),
        },
        startOnCreate: true,
      };
      const record = await apiClient.createHostedAgent(request);
      await loadState();
      setSelectedAgentId(record.agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch hosted negotiator.');
    } finally {
      setIsSubmitting(false);
    }
  }, [loadState, runtimeForm, runtimeValidationMessage, selectedAgentId, selectedMandateId, session.institution.id]);

  const handleStart = useCallback(async (id: string) => {
    setBusyAgentId(id);
    setError(null);
    try {
      await apiClient.startHostedAgent(id);
      await loadState();
      setSelectedAgentId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start hosted negotiator.');
    } finally {
      setBusyAgentId(null);
    }
  }, [loadState]);

  const handleStop = useCallback(async (id: string) => {
    setBusyAgentId(id);
    setError(null);
    try {
      await apiClient.stopHostedAgent(id);
      await loadState();
      setSelectedAgentId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop hosted negotiator.');
    } finally {
      setBusyAgentId(null);
    }
  }, [loadState]);

  const handleCopyLogs = useCallback(() => {
    if (!selectedHostedRecord?.runtime.logTail) return;
    navigator.clipboard.writeText(selectedHostedRecord.runtime.logTail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [selectedHostedRecord]);

  const mandateSummary = summarizeMandate(selectedMandate);

  const isStepUnlocked = useCallback((stepNumber: number) => {
    if (stepNumber === 1) return true;
    if (stepNumber === 2) return Boolean(selectedAgentId);
    if (stepNumber === 3) return Boolean(selectedAgentId && selectedMandateId);
    return false;
  }, [selectedAgentId, selectedMandateId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setActiveStep(1);
    }
  }, [selectedAgentId]);

  return (
    <div className="deploy-layout deploy-factory-layout">
      <header className="deploy-header deploy-header-hosted">
        <div className="deploy-header-left">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (activeStep > 1) {
                setActiveStep(activeStep - 1);
              } else {
                onBack();
              }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <ArrowLeft01Icon size={14} /> Back
          </button>
        </div>
        <div className="deploy-header-center">
          <h1 className="deploy-title">Hosted Negotiator</h1>
          <span className="deploy-subtitle">Provision agents, bind mandates, and launch hosted runtimes.</span>
        </div>
        <div className="deploy-header-right">
          <div className={`status-badge ${runningCount > 0 ? 'secure' : 'processing'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: runningCount > 0 ? 'var(--color-success)' : 'var(--color-warning)' }} />
            <span>{runningCount > 0 ? `${runningCount} live runtime${runningCount === 1 ? '' : 's'}` : 'Ready to launch'}</span>
          </div>
        </div>
      </header>

      {error ? (
        <div className="status-badge error deploy-error-banner" style={{ borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircleIcon size={14} /> {error}
        </div>
      ) : null}

      <div className="deploy-factory-grid">
        {/* Launch Controls */}
        <section className="card">
          <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
            <Shield01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Launch Flow
          </h2>

          <div className="deploy-form-grid deploy-guide-grid">
            {/* Wizard Nav */}
            <div className="deploy-wizard-nav deploy-form-span-full" aria-label="Hosted launch steps">
              {[
                { step: 1, kicker: 'Access', label: selectedAgentId ? 'Agent selected' : 'Choose or provision an admitted agent' },
                { step: 2, kicker: 'Mandate', label: selectedMandateId && !showMandateEditor ? 'Mandate bound' : 'Author negotiation policy' },
                { step: 3, kicker: 'Runtime', label: selectedAgentHasHostedRuntime ? 'Runtime attached' : 'Tune runtime and launch' },
              ].map((item) => {
                const unlocked = isStepUnlocked(item.step);
                return (
                  <button
                    key={item.step}
                    type="button"
                    onClick={() => {
                      if (unlocked) {
                        setActiveStep(item.step);
                      } else {
                        if (item.step === 2) {
                          setError('Please select or provision an admitted agent first.');
                        } else if (item.step === 3) {
                          setError('Please bind a negotiation mandate first.');
                        }
                      }
                    }}
                    className={`deploy-wizard-nav-item ${activeStep === item.step ? 'active' : activeStep > item.step ? 'completed' : ''}`}
                    aria-current={activeStep === item.step ? 'step' : undefined}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: unlocked ? 'pointer' : 'not-allowed',
                      opacity: unlocked ? 1 : 0.6,
                      width: '100%',
                      textAlign: 'left',
                    }}
                  >
                    <span className="deploy-wizard-nav-step">0{item.step}</span>
                    <div className="deploy-wizard-nav-content">
                      <span className="deploy-wizard-nav-kicker">{item.kicker}</span>
                      <span className="deploy-wizard-nav-label">{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Step 1: Agent Selection */}
            <div className="deploy-form-span-full" style={{ display: activeStep === 1 ? 'block' : 'none' }}>
              <section className="deploy-guide-section" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
                <div className="deploy-guide-section-header">
                  <span className="deploy-guide-step">01</span>
                  <div>
                    <h3 className="deploy-guide-heading">Admitted Agent</h3>
                    <p className="deploy-guide-copy">Pick the exact operator-approved agent you want to manage. Provisioning creates the durable delegation layer, then returns directly to mandate binding.</p>
                  </div>
                </div>

                <div className="form-group deploy-form-span-full">
                  <label className="form-label" htmlFor="deploy-agent-select">Select Admitted Agent</label>
                  {hasAdmittedAgents ? (
                    <>
                      <select
                        id="deploy-agent-select"
                        className="form-select"
                        value={selectedAgentId ?? ''}
                        onChange={(event) => {
                          setSelectedAgentId(event.target.value || null);
                          setShowMandateEditor(false);
                          setMandateValidationError(null);
                          setError(null);
                        }}
                      >
                        <option value="">Select agent…</option>
                        {admittedAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.label ?? agent.agentDid}
                          </option>
                        ))}
                      </select>
                      <span className="deploy-field-hint">
                        Select an admitted agent, or provision a new one inline.
                      </span>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--spacing-sm)' }}>
                        <button type="button" className="btn btn-secondary" onClick={() => setShowProvisioningForm((current) => !current)}>
                          {showProvisioningForm ? 'Hide Provisioning' : 'Provision Agent'}
                        </button>
                      </div>
                      {showProvisioningForm ? (
                        <AgentProvisioningForm
                          institutionId={session.institution.id}
                          description="Mint delegation and admit a new negotiator without breaking the current launch flow."
                          onProvisioned={handleProvisioned}
                        />
                      ) : null}
                    </>
                  ) : (
                    <div className="deploy-context-note" style={{ display: 'grid', gap: '12px' }}>
                      <div style={{ display: 'grid', gap: '6px' }}>
                        <strong style={{ fontSize: '0.82rem', color: 'var(--color-text-primary)' }}>No admitted agent available</strong>
                        <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }}>
                          Provision an agent here, then continue directly into mandate binding and hosted launch.
                        </span>
                      </div>
                      <AgentProvisioningForm
                        institutionId={session.institution.id}
                        submitLabel="Provision Agent"
                        onProvisioned={handleProvisioned}
                      />
                    </div>
                  )}
                </div>

                <div className="deploy-step-actions" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--spacing-lg)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!selectedAgentId}
                    onClick={() => {
                      if (selectedAgentId) {
                        setActiveStep(2);
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    Continue to Negotiation Mandate &rarr;
                  </button>
                </div>
              </section>
            </div>

            {/* Step 2: Mandate Bounds */}
            <div className="deploy-form-span-full" style={{ display: activeStep === 2 ? 'block' : 'none' }}>
              <section className="deploy-guide-section" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
                <div className="deploy-guide-section-header">
                  <span className="deploy-guide-step">02</span>
                  <div>
                    <h3 className="deploy-guide-heading">Negotiation Mandate</h3>
                    <p className="deploy-guide-copy">Author the policy the AI agent negotiates within — objective, size, tempo, trust, and disclosure rules. Numeric rails are derived automatically.</p>
                  </div>
                </div>

                {/* Selected agent summary */}
                <div className="deploy-context-note" style={{ marginBottom: 'var(--spacing-md)', padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(94, 210, 156, 0.05)', border: '1px solid rgba(94, 210, 156, 0.15)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.76rem', color: 'var(--color-text-primary)' }}>
                    Active Agent: <strong style={{ color: 'var(--color-accent)' }}>{selectedAgent?.label ?? (selectedAgent ? truncateMiddle(selectedAgent.agentDid, 12) : '')}</strong>
                  </span>
                  <button type="button" className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.7rem', height: 'auto', minHeight: 'unset' }} onClick={() => setActiveStep(1)}>
                    Change Agent
                  </button>
                </div>

                <div className="deploy-mandate-summary deploy-form-span-full" style={{ marginTop: 0 }}>
                  <span className="deploy-mandate-summary-label">Bound Negotiation Mandate</span>
                  <strong className="deploy-mandate-summary-title">
                    {selectedMandate ? `${selectedMandate.side.toUpperCase()} ${selectedMandate.assetCode}` : 'No active mandate attached'}
                  </strong>
                  <p className="deploy-mandate-summary-copy">
                    The authored policy — not trader-tuned numbers — governs the agent. Derived execution rails are sealed inside the enclave and cannot be overridden by the hosted runtime.
                  </p>
                  <div className="deploy-mandate-summary-grid">
                    {mandateSummary.map((item) => (
                      <div key={item.label} className="deploy-mandate-summary-item">
                        <span className="deploy-mandate-summary-item-label">{item.label}</span>
                        <span className="deploy-mandate-summary-item-value">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="form-group deploy-form-span-full" style={{ marginTop: 'var(--spacing-md)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <label className="form-label" htmlFor="mandate-id">Mandate Selection</label>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowMandateEditor((current) => !current)}>
                      {showMandateEditor ? 'Hide Mandate Editor' : selectedMandate ? 'Author / Replace Mandate' : 'Author Mandate'}
                    </button>
                  </div>
                  <select
                    id="mandate-id"
                    className="form-select"
                    value={selectedMandateId}
                    onChange={(event) => setSelectedMandateId(event.target.value)}
                    disabled={!selectedAgentId || selectedAgentMandates.length === 0}
                  >
                    <option value="">{selectedAgentId ? 'No active mandate selected' : 'Select an agent first'}</option>
                    {selectedAgentMandates.map((mandate) => (
                      <option key={mandate.id} value={mandate.id}>
                        {`${mandate.side.toUpperCase()} ${mandate.assetCode} • ${mandate.targetQuantity} • ${new Date(mandate.updatedAt).toLocaleDateString()}`}
                      </option>
                    ))}
                  </select>
                  <span className="deploy-field-hint">
                    {selectedAgentId
                      ? selectedAgentMandates.length > 0
                        ? 'Mandates are scoped to the selected agent.'
                        : 'No mandate exists for this agent yet. Create one now.'
                      : 'Select an admitted agent before binding a mandate.'}
                  </span>
                </div>

                {showMandateEditor ? (
                  <div className="deploy-form-span-full" style={{ marginTop: 'var(--spacing-md)' }}>
                    {mandateValidationError ? (
                      <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                        <AlertCircleIcon size={14} /> {mandateValidationError}
                      </div>
                    ) : null}
                    <MandateConfigForm
                      agentId={selectedAgentId ?? ''}
                      onSuccess={() => {
                        void handleMandateCommitted();
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--spacing-md)' }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setShowMandateEditor(false);
                          setMandateValidationError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="deploy-step-actions" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--spacing-lg)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setActiveStep(1)}>
                    &larr; Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!selectedMandateId || showMandateEditor}
                    onClick={() => {
                      if (selectedMandateId) {
                        setActiveStep(3);
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    Continue to Runtime Controls &rarr;
                  </button>
                </div>
              </section>
            </div>

            {/* Step 3: Runtime Controls + Launch */}
            <div className="deploy-form-span-full" style={{ display: activeStep === 3 ? 'block' : 'none' }}>
              <section className="deploy-guide-section" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
                <div className="deploy-guide-section-header">
                  <span className="deploy-guide-step">03</span>
                  <div>
                    <h3 className="deploy-guide-heading">Runtime Settings</h3>
                    <p className="deploy-guide-copy">Configure poll cadence, loop count, dry-run mode, and model selection before launching.</p>
                  </div>
                </div>

                {/* Selected agent & mandate summary */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-md)' }}>
                  <div className="deploy-context-note" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(94, 210, 156, 0.05)', border: '1px solid rgba(94, 210, 156, 0.15)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)' }}>
                      Agent: <strong style={{ color: 'var(--color-accent)' }}>{selectedAgent?.label ?? (selectedAgent ? truncateMiddle(selectedAgent.agentDid, 10) : '')}</strong>
                    </span>
                    <button type="button" className="btn btn-secondary" style={{ padding: '2px 6px', fontSize: '0.65rem', height: 'auto', minHeight: 'unset' }} onClick={() => setActiveStep(1)}>Edit</button>
                  </div>
                  <div className="deploy-context-note" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(94, 210, 156, 0.05)', border: '1px solid rgba(94, 210, 156, 0.15)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)' }}>
                      Mandate: <strong style={{ color: 'var(--color-accent)' }}>{selectedMandate ? `${selectedMandate.side.toUpperCase()} ${selectedMandate.assetCode}` : 'None'}</strong>
                    </span>
                    <button type="button" className="btn btn-secondary" style={{ padding: '2px 6px', fontSize: '0.65rem', height: 'auto', minHeight: 'unset' }} onClick={() => setActiveStep(2)}>Edit</button>
                  </div>
                </div>

                <div className="deploy-form-span-full" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
                  <div className="form-group">
                    <label className="form-label" htmlFor="runtime-poll">Poll Interval (ms)</label>
                    <input id="runtime-poll" className="form-input font-mono" value={runtimeForm.pollIntervalMs} onChange={(event) => setRuntimeForm((current) => ({ ...current, pollIntervalMs: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="runtime-max-ticks">Max Ticks</label>
                    <input id="runtime-max-ticks" className="form-input font-mono" value={runtimeForm.maxTicks} onChange={(event) => setRuntimeForm((current) => ({ ...current, maxTicks: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="runtime-model">Groq Model</label>
                    <input id="runtime-model" className="form-input font-mono" value={runtimeForm.groqModel} onChange={(event) => setRuntimeForm((current) => ({ ...current, groqModel: event.target.value }))} />
                  </div>
                  <label className="deploy-inline-toggle" style={{ cursor: 'pointer', margin: 'var(--spacing-sm) 0 0' }}>
                    <input type="checkbox" checked={runtimeForm.dryRun} onChange={(event) => setRuntimeForm((current) => ({ ...current, dryRun: event.target.checked }))} />
                    <span>Dry Run</span>
                  </label>
                </div>

                {runtimeValidationMessage ? (
                  <div className="status-badge error deploy-form-span-full" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
                    <AlertCircleIcon size={14} /> {runtimeValidationMessage}
                  </div>
                ) : null}

                <div className="deploy-wizard-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)', marginTop: 'var(--spacing-lg)' }}>
                  <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                    <button type="button" className="btn btn-secondary" onClick={() => setActiveStep(2)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      &larr; Back
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => { setIsLoading(true); loadState().finally(() => setIsLoading(false)); }} disabled={isLoading || isSubmitting}>
                      <Refresh01Icon size={14} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} /> Synchronize
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleLaunch}
                    disabled={!canLaunch || isSubmitting}
                    title={!selectedMandateId ? 'Create or attach a negotiation mandate first.' : runtimeValidationMessage ?? undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    {isSubmitting ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RocketIcon size={14} />} Launch Hosted Negotiator
                  </button>
                </div>
              </section>
            </div>
          </div>
        </section>

        {/* Fleet State */}
        <section className="card">
          <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
            <Activity01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Fleet & Runtime State
          </h2>
          <p style={{ margin: '0 0 var(--spacing-md) 0', color: 'var(--color-text-secondary)', fontSize: '0.75rem' }}>
            {runningCount > 0
              ? `${runningCount} hosted runtime${runningCount === 1 ? '' : 's'} currently tracked.`
              : 'No hosted runtimes attached yet.'}
          </p>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-secondary)' }}>
              <Loading03Icon size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading hosted negotiators…
            </div>
          ) : hostedAgents.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              {hasAdmittedAgents
                ? 'Admitted agents are available. Bind a mandate and launch from the controls above.'
                : 'No hosted negotiators configured yet.'}
            </p>
          ) : (
            <div className="deploy-agent-fleet">
              {hostedAgents.map((record) => (
                <button
                  key={record.agent.id}
                  type="button"
                  className={`deploy-agent-runtime ${record.agent.id === selectedAgentId ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedAgentId(record.agent.id);
                    setShowMandateEditor(false);
                    setMandateValidationError(null);
                    setError(null);
                  }}
                >
                  <div className="deploy-agent-runtime-main">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.8rem' }}>
                        {record.agent.label ?? truncateMiddle(record.agent.agentDid, 10)}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
                        {record.mandate ? `${record.mandate.side.toUpperCase()} • ${record.mandate.assetCode} • ${record.mandate.targetQuantity}` : 'No active mandate'}
                      </span>
                    </div>
                    <span className={`status-badge ${record.migrationState === 'ready' ? 'secure' : 'error'}`} style={{ display: 'inline-flex', fontSize: '0.62rem', padding: '2px 8px', borderRadius: '4px' }}>
                      {record.migrationState === 'ready' ? 'READY' : 'NEEDS MIGRATION'}
                    </span>
                  </div>
                  <div className="deploy-agent-runtime-meta">
                    <span title={record.agent.agentDid}>DID: {truncateMiddle(record.agent.agentDid, 9)}</span>
                    <span>{record.runtime.running ? 'RUNNING' : 'STOPPED'} • {formatTimestamp(record.runtime.startedAt)}</span>
                  </div>
                  {record.migrationState === 'needs_migration' ? (
                    <div className="deploy-runtime-error" style={{ marginTop: '8px' }}>
                      <AlertCircleIcon size={14} />
                      <span>Legacy deploy config detected. Attach a negotiation mandate to relaunch.</span>
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Runtime Telemetry */}
        <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
          <h2 className="card-title" style={{ margin: 0 }}>
            <Activity01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Runtime Telemetry
          </h2>
          {!selectedHostedRecord ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              {selectedAgentId && !selectedAgentHasHostedRuntime
                ? 'Selected agent does not have a hosted runtime yet. Bind a mandate and launch from the controls above.'
                : hasHostedAgents
                  ? 'Select a hosted negotiator from the fleet list above to inspect runtime state.'
                  : hasAdmittedAgents
                    ? 'No hosted runtime attached yet. Bind a mandate and launch.'
                    : 'Provision an agent first, then this panel will stream hosted runtime telemetry.'}
            </p>
          ) : (
            <>
              <div className="process-dashboard">
                <div className="process-cell">
                  <span className="process-label">Mandate</span>
                  <span className="process-value active">{selectedHostedRecord.mandate ? `${selectedHostedRecord.mandate.side.toUpperCase()} ${selectedHostedRecord.mandate.assetCode}` : 'Detached'}</span>
                </div>
                <div className="process-cell">
                  <span className="process-label">PID</span>
                  <span className="process-value">{selectedHostedRecord.runtime.pid || 'OFFLINE'}</span>
                </div>
                <div className="process-cell">
                  <span className="process-label">Session Expires</span>
                  <span className="process-value">{selectedHostedRecord.runtime.sessionExpiresAt ? formatTimestamp(selectedHostedRecord.runtime.sessionExpiresAt) : 'Not issued'}</span>
                </div>
              </div>

              <div className="deploy-runtime-actions" style={{ display: 'flex', gap: 'var(--spacing-md)' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyAgentId === selectedHostedRecord.agent.id || selectedHostedRecord.runtime.running || selectedHostedRecord.migrationState === 'needs_migration'}
                  onClick={() => handleStart(selectedHostedRecord.agent.id)}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                >
                  {busyAgentId === selectedHostedRecord.agent.id && !selectedHostedRecord.runtime.running ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <PlayIcon size={14} />}
                  Start
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busyAgentId === selectedHostedRecord.agent.id || !selectedHostedRecord.runtime.running}
                  onClick={() => handleStop(selectedHostedRecord.agent.id)}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                >
                  {busyAgentId === selectedHostedRecord.agent.id && selectedHostedRecord.runtime.running ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <StopIcon size={14} />}
                  Stop
                </button>
              </div>

              <div className="sec-terminal" style={{ flex: 1 }}>
                <div className="sec-terminal-header">
                  <div className="sec-terminal-window-dots">
                    <span className="sec-terminal-dot red" />
                    <span className="sec-terminal-dot yellow" />
                    <span className="sec-terminal-dot green" />
                  </div>
                  <span className="sec-terminal-title">hosted-negotiator@ghostbroker:~</span>
                  <button type="button" className="sec-terminal-action-btn" onClick={handleCopyLogs} title="Copy telemetry output" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.62rem', fontFamily: 'var(--font-mono)' }}>
                    <Copy01Icon size={12} /> {copied ? 'COPIED' : 'COPY'}
                  </button>
                </div>
                <div className="sec-terminal-body">
                  {selectedHostedRecord.runtime.logTail ? selectedHostedRecord.runtime.logTail.split('\n').map((line, idx) => <div key={idx} className="sec-terminal-line">{line}</div>) : <div className="sec-terminal-line text-muted">No execution logs streamed yet.</div>}
                </div>
              </div>

              {selectedHostedRecord.runtime.lastError ? (
                <div className="deploy-runtime-error">
                  <AlertCircleIcon size={14} /> <span>{selectedHostedRecord.runtime.lastError}</span>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default AgentDeploymentGuide;
