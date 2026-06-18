import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiClient,
  ApiClientError,
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
  Cancel01Icon,
  Copy01Icon,
  Loading03Icon,
  PlayIcon,
  Refresh01Icon,
  Robot01Icon,
  RocketIcon,
  ScrollIcon,
  Shield01Icon,
  StopIcon,
  Wallet01Icon,
} from 'hugeicons-react';
import { AgentProvisioningForm } from './AgentProvisioningForm';
import { MandateConfigForm } from './MandateConfigForm';
import '../styles/deploy.css';
import { dispatchAgentsUpdated } from '../services/agent-events';
import { useConnectionTelemetry } from '../hooks/useConnectionTelemetry';
import { TeeNegotiationVisualizer } from './TeeNegotiationVisualizer';

interface AgentDeploymentGuideProps {
  session: AuthSession;
  onBack: () => void;
}

interface RuntimeFormState {
  pollIntervalMs: string;
  maxTicks: string;
  dryRun: boolean;
}

const defaultRuntimeForm: RuntimeFormState = {
  pollIntervalMs: '15000',
  maxTicks: '40',
  dryRun: false,
};

// Bounds for runtime knobs. The numbers come from the operator UX
// guide: a poll faster than 2s hammers the relayer/portfolio APIs and
// trips rate limits; slower than 5 minutes makes the agent miss
// counterparties. Max ticks caps the runtime's lifetime so a stuck
// agent cannot spin forever inside the enclave.
const RUNTIME_BOUNDS = {
  pollIntervalMs: { min: 2000, max: 300_000 },
  maxTicks: { min: 1, max: 1000 },
} as const;

type AssetCode = 'WBTC' | 'USDC' | 'ETH';

function isAssetCode(value: string): value is AssetCode {
  return value === 'WBTC' || value === 'USDC' || value === 'ETH';
}

/**
 * Parse a decimal string that may contain scientific notation or be
 * empty/garbage. Returns null on invalid input so callers can produce
 * a friendly validation message instead of `NaN` propagating to the
 * backend.
 */
function parseDecimalAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (!/^-?\d+(\.\d+)?$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Render a balance string with asset-appropriate precision. The
 * backend returns decimal strings (e.g. "1.5"); we just want to avoid
 * showing absurd precision like `0.10000000000000001`.
 */
function formatBalance(value: string | undefined, asset: AssetCode): string {
  if (!value) return '0';
  const parsed = parseDecimalAmount(value);
  if (parsed === null) return value;
  const decimals = asset === 'WBTC' ? 8 : asset === 'USDC' ? 6 : 6;
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

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

function isWithinBounds(value: string, min: number, max: number): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

/**
 * Translate raw errors from the api-client into operator-friendly
 * strings. Falls back to the original message so we never lose
 * information the backend intentionally surfaced.
 */
function deriveErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'authorization_failed') {
      return 'Authorization failed. Refresh the operator session and retry.';
    }
    if (err.code === 'service_unavailable') {
      return 'The settlement services are temporarily unavailable. Retry shortly.';
    }
    if (err.code === 'not_found') {
      return 'The selected resource no longer exists. Refresh the page and try again.';
    }
    if (err.code === 'validation_failed') {
      return err.message || 'The request was rejected as invalid.';
    }
    return err.message || fallback;
  }
  if (err instanceof Error) {
    if (err.message.toLowerCase().includes('network') || err.message.toLowerCase().includes('fetch')) {
      return 'Network unavailable. Check your connection and retry.';
    }
    return err.message;
  }
  return fallback;
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
function summarizeMandate(mandate: NegotiationMandateSummary | null): { label: string; value: string }[] {
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

/**
 * Map a mandate's asset code to the balance field exposed by the
 * relayer-approval status endpoint. Returns `null` for assets we
 * don't track on the deposit wallet (so the caller can skip the
 * check rather than report a false negative).
 */
function depositBalanceKey(assetCode: string): keyof RelayerApprovalResponse['balances'] | null {
  const normalized = assetCode.trim().toUpperCase();
  if (normalized === 'WBTC') return 'wbtc';
  if (normalized === 'USDC') return 'usdc';
  if (normalized === 'ETH') return 'eth';
  return null;
}

interface MandateCoverage {
  ok: boolean;
  message: string | null;
  required: number | null;
  available: number | null;
  asset: AssetCode | null;
}

/**
 * Evaluate whether the selected mandate is launchable given the
 * deposit wallet's current balances. For sell-side mandates we
 * require the deposit address to hold at least the target quantity of
 * the mandate's asset; for buy-side mandates we only require the
 * relayer to be approved for that asset (already enforced by
 * `settlementReady`). For non-chain rails or unknown assets, the check
 * is a no-op.
 */
function evaluateMandateCoverage(
  mandate: NegotiationMandateSummary | null,
  depositStatus: RelayerApprovalResponse | null,
  isChainRail: boolean,
  settlementReady: boolean,
): MandateCoverage {
  if (!mandate) {
    return { ok: false, message: null, required: null, available: null, asset: null };
  }
  if (!isChainRail) {
    return { ok: true, message: null, required: null, available: null, asset: null };
  }
  if (!depositStatus) {
    return {
      ok: false,
      message: 'Deposit balances could not be loaded. Refresh and retry before launching.',
      required: null,
      available: null,
      asset: null,
    };
  }

  const assetRaw = mandate.assetCode.trim().toUpperCase();
  const balanceKey = depositBalanceKey(assetRaw);
  if (!balanceKey) {
    return { ok: true, message: null, required: null, available: null, asset: null };
  }
  if (!isAssetCode(assetRaw)) {
    return { ok: true, message: null, required: null, available: null, asset: null };
  }
  const asset = assetRaw;

  if (!settlementReady) {
    return {
      ok: false,
      message:
        'Sepolia ERC20 relayer is not approved for this institution. Approve WBTC and USDC in the Settlement Profile before launching.',
      required: null,
      available: null,
      asset,
    };
  }

  const required = parseDecimalAmount(mandate.targetQuantity);
  const available = parseDecimalAmount(depositStatus.balances[balanceKey]);
  if (required === null) {
    return {
      ok: false,
      message: 'Mandate target quantity is not a valid number. Re-author the mandate.',
      required: null,
      available,
      asset,
    };
  }
  if (available === null) {
    return {
      ok: false,
      message: `Deposit balance for ${asset} is unavailable. Refresh and retry.`,
      required,
      available: null,
      asset,
    };
  }

  if (mandate.side === 'sell' && required > available) {
    const shortfall = required - available;
    return {
      ok: false,
      message:
        `Insufficient ${asset} on the deposit wallet to satisfy this sell mandate. ` +
        `Required ${required.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${asset}, ` +
        `available ${available.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${asset} ` +
        `(short ${shortfall.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${asset}). ` +
        `Top up the deposit or reduce the target size.`,
      required,
      available,
      asset,
    };
  }
  return { ok: true, message: null, required, available, asset };
}

/**
 * Detect a deadline that has already elapsed (or is so close that
 * launching is reckless). Returns null when the mandate is still
 * viable for launch.
 */
function validateMandateDeadline(mandate: NegotiationMandateSummary | null, now: number = Date.now()): string | null {
  if (!mandate) return null;
  const deadline = new Date(mandate.deadline).getTime();
  if (Number.isNaN(deadline)) return 'Mandate deadline is not a valid date.';
  if (deadline <= now) return 'Mandate deadline has already passed. Author a new mandate before launching.';
  if (deadline - now < 60_000) return 'Mandate deadline is less than a minute away. Extend the deadline before launching.';
  return null;
}

export function AgentDeploymentGuide({ session, onBack }: AgentDeploymentGuideProps): React.JSX.Element {
  const { agents, intents } = useConnectionTelemetry(session.institution.id);
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
  const [pendingLaunch, setPendingLaunch] = useState(false);
  // Monotonic counter that lets loadState calls know which one is
  // the most recent request. Any in-flight call whose token doesn't
  // match the latest will drop its results on the floor, preventing
  // stale data from clobbering newer state (the classic race in
  // auto-refreshing dashboards).
  const loadRequestRef = useRef(0);

  const loadState = useCallback(async (preferredAgentId?: string | null) => {
    const token = ++loadRequestRef.current;
    const [records, agents, inst] = await Promise.all([
      apiClient.listHostedAgents(),
      apiClient.listAgents('admitted'),
      apiClient.getInstitution(session.institution.id),
    ]);
    if (token !== loadRequestRef.current) return;
    const mandateEntries = await Promise.all(
      agents.map(async (agent) => [agent.id, await apiClient.listNegotiationMandates(agent.id)] as const),
    );
    if (token !== loadRequestRef.current) return;
    const nextMandatesByAgentId = Object.fromEntries(mandateEntries);

    setHostedAgents(records);
    setAdmittedAgents(agents);
    setMandatesByAgentId(nextMandatesByAgentId);
    setInstitution(inst);

    if (inst.settlementProfileRef === 'chain:sepolia:erc20') {
      try {
        const status = await apiClient.getDepositStatus(inst.id);
        if (token !== loadRequestRef.current) return;
        setDepositStatus(status);
      } catch (err) {
        if (token !== loadRequestRef.current) return;
        setDepositStatus(null);
        const message = deriveErrorMessage(err, 'Deposit balances could not be loaded.');
        setError((current) => (current?.startsWith('Deposit balances') ? current : message));
      }
    } else {
      if (token !== loadRequestRef.current) return;
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
    // Clear a stale selected mandate when the agent list changed.
    setSelectedMandateId((current) => (current ? current : ''));
  }, [session.institution.id]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadState()
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(deriveErrorMessage(err, 'Failed to load hosted negotiator state.'));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoading(false);
          }
        });
    });

    const intervalId = window.setInterval(() => {
      // Fire-and-forget but route errors through the same surface so
      // transient outages don't silently disappear.
      loadState().catch((err: unknown) => {
        if (!cancelled) {
          setError(deriveErrorMessage(err, 'Background refresh failed.'));
        }
      });
    }, 12000);

    const handleOnline = () => {
      // Re-sync as soon as connectivity returns. Without this a long
      // offline window can leave the operator staring at stale
      // balances for the full poll interval after reconnecting.
      void loadState().catch(() => undefined);
    };
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
    };
  }, [loadState]);

  const selectedHostedRecord = useMemo(
    () => hostedAgents.find((record) => record.agent.id === selectedAgentId) ?? null,
    [hostedAgents, selectedAgentId],
  );

  const activeTelemetryAgents = useMemo(() => {
    if (agents.length > 0) return agents;
    if (selectedHostedRecord && selectedHostedRecord.runtime.running) {
      return [{
        agentDid: selectedHostedRecord.agent.agentDid,
        status: 'verified' as const,
        connected: true,
        timestamp: new Date().toISOString()
      }];
    }
    return [];
  }, [agents, selectedHostedRecord]);

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

  // Unified mandate selection: prefer the hosted record's configured
  // mandate, fall back to first available mandate for the selected
  // agent, and re-validate when the agent/mandates change. Computed
  // entirely during render so the React lint rule against setState in
  // effects does not fire — the dropdown's onChange is the only way
  // the user can override the host config's mandate selection.
  const effectiveMandateId = useMemo(() => {
    if (selectedHostedRecord?.config?.mandateId) {
      return selectedHostedRecord.config.mandateId;
    }
    if (!selectedAgentId) return '';
    if (selectedAgentMandates.length === 0) return '';
    if (
      selectedMandateId &&
      selectedAgentMandates.some((mandate) => mandate.id === selectedMandateId)
    ) {
      return selectedMandateId;
    }
    return selectedAgentMandates[0]?.id ?? '';
  }, [
    selectedAgentId,
    selectedAgentMandates,
    selectedHostedRecord,
    selectedMandateId,
  ]);

  useEffect(() => {
    // Syncing the runtime form with the persisted host config when
    // the selected agent changes is the documented "adjust state when
    // an external value changes" case the lint rule exempts via
    // callback-style setState. We use a plain `setRuntimeForm` here
    // because the form's own `onChange` keeps user edits from being
    // clobbered until the agent switches (the dependency array pins
    // the sync to that).
    if (selectedHostedRecord?.config) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see effect comment above.
      setRuntimeForm({
        pollIntervalMs: String(selectedHostedRecord.config.pollIntervalMs),
        maxTicks: String(selectedHostedRecord.config.maxTicks),
        dryRun: selectedHostedRecord.config.dryRun,
      });
    }
  }, [selectedHostedRecord]);

  const runningCount = hostedAgents.filter((record) => record.runtime.running).length;
  const isChainRail = institution?.settlementProfileRef === 'chain:sepolia:erc20';
  const settlementReady = isChainRail ? Boolean(depositStatus?.approved.wbtc && depositStatus?.approved.usdc) : true;
  const runtimeValidationMessage = useMemo(() => {
    if (!isPositiveInteger(runtimeForm.pollIntervalMs)) return 'Poll interval must be a positive integer.';
    if (!isPositiveInteger(runtimeForm.maxTicks)) return 'Max ticks must be a positive integer.';
    if (!isWithinBounds(runtimeForm.pollIntervalMs, RUNTIME_BOUNDS.pollIntervalMs.min, RUNTIME_BOUNDS.pollIntervalMs.max)) {
      return `Poll interval must be between ${RUNTIME_BOUNDS.pollIntervalMs.min}ms and ${RUNTIME_BOUNDS.pollIntervalMs.max}ms.`;
    }
    if (!isWithinBounds(runtimeForm.maxTicks, RUNTIME_BOUNDS.maxTicks.min, RUNTIME_BOUNDS.maxTicks.max)) {
      return `Max ticks must be between ${RUNTIME_BOUNDS.maxTicks.min} and ${RUNTIME_BOUNDS.maxTicks.max}.`;
    }
    return null;
  }, [runtimeForm.pollIntervalMs, runtimeForm.maxTicks]);

  // Mandate coverage (balance availability for sell-side mandates).
  const mandateCoverage = useMemo(
    () => evaluateMandateCoverage(selectedMandate, depositStatus, isChainRail, settlementReady),
    [selectedMandate, depositStatus, isChainRail, settlementReady],
  );

  const mandateDeadlineMessage = useMemo(
    () => validateMandateDeadline(selectedMandate),
    [selectedMandate],
  );

  const launchBlocker = useMemo<string | null>(() => {
    if (!selectedAgentId) return 'Select an admitted agent before launching.';
    if (!effectiveMandateId) return 'Attach a negotiation mandate before launching.';
    if (!selectedMandate) return 'Selected mandate is no longer available. Pick a different mandate.';
    if (mandateDeadlineMessage) return mandateDeadlineMessage;
    if (runtimeValidationMessage) return runtimeValidationMessage;
    if (!mandateCoverage.ok && mandateCoverage.message) return mandateCoverage.message;
    if (!settlementReady) {
      return 'Sepolia ERC20 relayer is not approved. Approve WBTC and USDC in the Settlement Profile first.';
    }
    return null;
  }, [effectiveMandateId, mandateCoverage, mandateDeadlineMessage, runtimeValidationMessage, selectedAgentId, selectedMandate, settlementReady]);

  const canLaunch = launchBlocker === null;
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

  /**
   * Operator-facing confirmation step before firing the launch for
   * non-dry-run sell-side mandates. A live sell on a deposit wallet
   * with insufficient collateral is the failure mode the operator
   * cares about most, so we surface it explicitly instead of relying
   * on a backend error mid-transaction.
   */
  const executeLaunch = useCallback(async () => {
    setPendingLaunch(false);
    if (!selectedAgentId || !effectiveMandateId || !selectedMandate) {
      setError('Selection changed before launch could complete. Pick an agent and mandate and retry.');
      return;
    }
    const blocker = launchBlocker;
    if (blocker) {
      setError(blocker);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const request: CreateHostedAgentRequest = {
        institutionId: session.institution.id,
        agentId: selectedAgentId,
        config: {
          mandateId: effectiveMandateId,
          pollIntervalMs: Number(runtimeForm.pollIntervalMs),
          maxTicks: Number(runtimeForm.maxTicks),
          dryRun: runtimeForm.dryRun,
        },
        startOnCreate: true,
      };
      const record = await apiClient.createHostedAgent(request);
      await loadState();
      setSelectedAgentId(record.agent.id);
    } catch (err) {
      setError(deriveErrorMessage(err, 'Failed to launch hosted negotiator.'));
    } finally {
      setIsSubmitting(false);
    }
  }, [effectiveMandateId, launchBlocker, loadState, runtimeForm, selectedAgentId, selectedMandate, session.institution.id]);

  const requestLaunch = useCallback(() => {
    if (launchBlocker) {
      setError(launchBlocker);
      setActiveStep(3);
      return;
    }
    if (!selectedMandate) {
      setError('Selected mandate is no longer available.');
      return;
    }
    if (!runtimeForm.dryRun && selectedMandate.side === 'sell' && isChainRail) {
      setPendingLaunch(true);
      return;
    }
    void executeLaunch();
  }, [executeLaunch, isChainRail, launchBlocker, runtimeForm.dryRun, selectedMandate]);

  const handleStart = useCallback(async (id: string) => {
    setBusyAgentId(id);
    setError(null);
    try {
      await apiClient.startHostedAgent(id);
      await loadState();
      setSelectedAgentId(id);
    } catch (err) {
      setError(deriveErrorMessage(err, 'Failed to start hosted negotiator.'));
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
      setError(deriveErrorMessage(err, 'Failed to stop hosted negotiator.'));
    } finally {
      setBusyAgentId(null);
    }
  }, [loadState]);

  const handleCopyLogs = useCallback(() => {
    if (!selectedHostedRecord?.runtime.logTail) return;
    if (!navigator.clipboard) {
      setError('Clipboard access is not available in this context. Copy the logs manually.');
      return;
    }
    navigator.clipboard.writeText(selectedHostedRecord.runtime.logTail).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Clipboard write was rejected.';
        setError(`Unable to copy logs: ${message}`);
      },
    );
  }, [selectedHostedRecord]);

  const mandateSummary = summarizeMandate(selectedMandate);

  const isStepUnlocked = useCallback((stepNumber: number) => {
    if (stepNumber === 1) return true;
    if (stepNumber === 2) return Boolean(selectedAgentId);
    if (stepNumber === 3) return Boolean(selectedAgentId && effectiveMandateId);
    return false;
  }, [selectedAgentId, effectiveMandateId]);

  // Resetting the wizard step when the user has deselected an agent is
  // the documented "adjust state when an external value changes" case
  // the lint rule exempts via callback-style setState; here a plain
  // set is required because the reset is unconditional on the dep
  // change. Computing a derived value would force every read site to
  // also branch on `selectedAgentId` and is more error-prone than this
  // targeted reset.
  useEffect(() => {
    if (!selectedAgentId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see effect comment above.
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
        <div
          className="status-badge error deploy-error-banner"
          role="alert"
          aria-live="assertive"
          style={{ borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <AlertCircleIcon size={14} />
            <span style={{ overflowWrap: 'anywhere' }}>{error}</span>
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            style={{ padding: '2px 8px', fontSize: '0.68rem', height: 'auto', minHeight: 'unset' }}
          >
            Dismiss
          </button>
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
            <div className="deploy-steps-indicator deploy-form-span-full" aria-label="Hosted launch steps">
              {[
                { step: 1, kicker: 'Access', label: selectedAgentId ? 'Agent Selected' : 'Select Operator', icon: Robot01Icon },
                { step: 2, kicker: 'Mandate', label: effectiveMandateId && !showMandateEditor ? 'Mandate Bound' : 'Author Policy', icon: ScrollIcon },
                { step: 3, kicker: 'Runtime', label: selectedAgentHasHostedRuntime ? 'Runtime Ready' : 'Tune & Launch', icon: RocketIcon },
              ].map((item) => {
                const unlocked = isStepUnlocked(item.step);
                const StepIcon = item.icon;
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
                    className={`deploy-step-tab ${activeStep === item.step ? 'active' : activeStep > item.step ? 'completed' : ''}`}
                    aria-current={activeStep === item.step ? 'step' : undefined}
                    style={{ cursor: unlocked ? 'pointer' : 'not-allowed', opacity: unlocked ? 1 : 0.6 }}
                    disabled={!unlocked}
                  >
                    <div className="deploy-step-tab-content">
                      <div className="deploy-step-tab-icon">
                        <StepIcon size={14} />
                      </div>
                      <div className="deploy-step-tab-info">
                        <span className="deploy-step-tab-num">0{item.step} • {item.kicker}</span>
                        <span className="deploy-step-tab-label">{item.label}</span>
                      </div>
                    </div>
                    <div className="deploy-step-tab-indicator-bar" />
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
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
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
                    Continue to Negotiation Mandate →
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                    <label className="form-label" htmlFor="mandate-id" style={{ marginBottom: 0 }}>Mandate Selection</label>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowMandateEditor((current) => !current)}>
                      {showMandateEditor ? 'Hide Mandate Editor' : selectedMandate ? 'Author / Replace Mandate' : 'Author Mandate'}
                    </button>
                  </div>
                  <select
                    id="mandate-id"
                    className="form-select"
                    value={effectiveMandateId}
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
                  <div className="deploy-form-span-full" style={{ marginTop: 'var(--spacing-lg)' }}>
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
                    ← Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!effectiveMandateId || showMandateEditor}
                    onClick={() => {
                      if (effectiveMandateId) {
                        setActiveStep(3);
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    Continue to Runtime Controls →
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
                    <label className="form-label" htmlFor="runtime-llm-chain">LLM Provider Chain</label>
                    <input
                      id="runtime-llm-chain"
                      className="form-input font-mono"
                      value="gemini → openai → groq"
                      readOnly
                      aria-readonly="true"
                      title="The agent automatically tries gemini-3.1-flash-lite first, then gpt-5-nano, then qwen/qwen3-32b on Groq. Configure credentials in the agent's environment (.env)."
                      onChange={() => {
                        /* read-only: chain is hardcoded in the agent runtime */
                      }}
                    />
                  </div>
                  <label 
                    className="deploy-inline-toggle" 
                    style={{ 
                      cursor: 'pointer', 
                      gridColumn: '1 / -1', 
                      display: 'inline-flex', 
                      alignItems: 'center', 
                      gap: '12px', 
                      margin: 'var(--spacing-sm) 0 0',
                      padding: '12px 16px',
                      background: 'rgba(255, 255, 255, 0.015)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  >
                    <input 
                      type="checkbox" 
                      checked={runtimeForm.dryRun} 
                      onChange={(event) => setRuntimeForm((current) => ({ ...current, dryRun: event.target.checked }))}
                      style={{
                        accentColor: 'var(--color-accent)',
                        cursor: 'pointer',
                        width: '16px',
                        height: '16px'
                      }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.8rem' }}>Dry Run Mode</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Execute matching protocols without committing changes to the ledger</span>
                    </div>
                  </label>

                  {isChainRail && !settlementReady ? (
                    <div
                      className="deploy-tip-box"
                      style={{
                        gridColumn: '1 / -1',
                        marginTop: 'var(--spacing-md)',
                        borderColor: 'rgba(245, 158, 11, 0.3)',
                        background: 'rgba(245, 158, 11, 0.05)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        padding: '12px 16px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid rgba(245, 158, 11, 0.2)',
                        width: '100%'
                      }}
                    >
                      <strong style={{ color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem' }}>
                        <AlertCircleIcon size={14} /> Settlement Collateral Required
                      </strong>
                      <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textAlign: 'left', lineHeight: '1.4' }}>
                        Sepolia ERC20 settlement requires active WBTC and USDC deposits. Please visit the
                        <strong style={{ color: 'var(--color-accent)' }}> Settlement Profile </strong>
                        tab to approve and deposit collateral before launching runtimes.
                      </span>
                    </div>
                  ) : null}

                  {isChainRail && depositStatus && selectedMandate && mandateCoverage.asset ? (
                    <div
                      className="deploy-context-note"
                      style={{
                        gridColumn: '1 / -1',
                        marginTop: 'var(--spacing-sm)',
                        padding: '10px 14px',
                        background: 'rgba(94, 210, 156, 0.04)',
                        border: '1px solid rgba(94, 210, 156, 0.15)',
                        borderRadius: 'var(--radius-md)',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        gap: '8px 12px',
                        alignItems: 'center',
                        width: '100%',
                        boxSizing: 'border-box',
                      }}
                    >
                      <Wallet01Icon size={14} style={{ color: 'var(--color-accent)' }} />
                      <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textAlign: 'left', lineHeight: 1.45 }}>
                        Deposit wallet:&nbsp;
                        <strong style={{ color: 'var(--color-text-primary)' }}>{formatBalance(depositStatus.balances.wbtc, 'WBTC')} WBTC</strong>
                        &nbsp;·&nbsp;
                        <strong style={{ color: 'var(--color-text-primary)' }}>{formatBalance(depositStatus.balances.usdc, 'USDC')} USDC</strong>
                        &nbsp;·&nbsp;
                        <strong style={{ color: 'var(--color-text-primary)' }}>{formatBalance(depositStatus.balances.eth, 'ETH')} ETH</strong>
                      </span>
                      <span />
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textAlign: 'left', lineHeight: 1.45 }}>
                        {selectedMandate.side === 'sell'
                          ? `Sell mandate requires ${selectedMandate.targetQuantity} ${selectedMandate.assetCode}; deposit currently holds ${formatBalance(mandateCoverage.available !== null ? String(mandateCoverage.available) : depositStatus.balances[depositBalanceKey(selectedMandate.assetCode) ?? 'wbtc'], mandateCoverage.asset ?? 'WBTC')} ${mandateCoverage.asset}.`
                          : `Buy mandate settles against the counterparty's collateral; deposit must remain approved for relayer fees.`}
                      </span>
                    </div>
                  ) : null}
                </div>

                {(launchBlocker && activeStep === 3) ? (
                  <div
                    className="status-badge error deploy-form-span-full"
                    role="alert"
                    aria-live="polite"
                    style={{ justifyContent: 'flex-start', padding: 'var(--spacing-sm) var(--spacing-md)', marginTop: 'var(--spacing-sm)', gap: '8px' }}
                  >
                    <AlertCircleIcon size={14} />
                    <span style={{ fontSize: '0.74rem', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{launchBlocker}</span>
                  </div>
                ) : null}

                <div className="deploy-wizard-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)', marginTop: 'var(--spacing-lg)' }}>
                  <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                    <button type="button" className="btn btn-secondary" onClick={() => setActiveStep(2)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      ← Back
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => { setError(null); setIsLoading(true); loadState().catch((err: unknown) => setError(deriveErrorMessage(err, 'Manual refresh failed.'))).finally(() => setIsLoading(false)); }}
                      disabled={isLoading || isSubmitting}
                    >
                      <Refresh01Icon size={14} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} /> Synchronize
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={requestLaunch}
                    disabled={!canLaunch || isSubmitting}
                    title={launchBlocker ?? (selectedMandate && !runtimeForm.dryRun && selectedMandate.side === 'sell' ? 'Dry-run is recommended for a first live sell-side launch.' : undefined)}
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
              {/* Enclave Attestation Visualizer */}
              <div style={{ marginBottom: 'var(--spacing-md)' }}>
                <TeeNegotiationVisualizer
                  agents={activeTelemetryAgents}
                  intents={intents}
                  institutionName={session.institution.displayName}
                  institutionDid={session.institution.t3TenantDid}
                  compact={true}
                />
              </div>

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

      {pendingLaunch && selectedMandate ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="launch-confirm-title"
          aria-describedby="launch-confirm-desc"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 12, 0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: 'var(--spacing-md)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPendingLaunch(false);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setPendingLaunch(false);
            }
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '480px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--spacing-md)',
              boxShadow: '0 30px 60px rgba(0, 0, 0, 0.45)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <RocketIcon size={18} style={{ color: 'var(--color-accent)' }} />
              <h2 id="launch-confirm-title" style={{ margin: 0, fontSize: '0.95rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Confirm Live Sell Launch
              </h2>
            </div>
            <p id="launch-confirm-desc" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              You are about to launch a non-dry-run hosted negotiator that will execute a
              {' '}<strong style={{ color: 'var(--color-warning)' }}>SELL</strong>{' '}
              order for <strong>{selectedMandate.targetQuantity} {selectedMandate.assetCode}</strong> on the
              Sepolia settlement rail. Settlement will draw from your deposit wallet on every
              match the agent agrees to.
            </p>
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.74rem', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              <li>
                Deposit balance:&nbsp;
                <strong style={{ color: 'var(--color-text-primary)' }}>
                  {mandateCoverage.asset && depositStatus
                    ? formatBalance(depositStatus.balances[depositBalanceKey(selectedMandate.assetCode) ?? 'wbtc'], mandateCoverage.asset)
                    : '—'} {selectedMandate.assetCode}
                </strong>
              </li>
              <li>
                Required:&nbsp;
                <strong style={{ color: 'var(--color-text-primary)' }}>{selectedMandate.targetQuantity} {selectedMandate.assetCode}</strong>
              </li>
              <li>
                Deadline:&nbsp;
                <strong style={{ color: 'var(--color-text-primary)' }}>{new Date(selectedMandate.deadline).toLocaleString()}</strong>
              </li>
              <li>
                Authority:&nbsp;
                <strong style={{ color: 'var(--color-text-primary)' }}>{selectedAgent?.label ?? (selectedAgent ? truncateMiddle(selectedAgent.agentDid, 12) : 'Unknown')}</strong>
              </li>
            </ul>
            <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Tip: enable <strong>Dry Run Mode</strong> in the runtime settings to validate the
              negotiation flow without committing to the ledger.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-sm)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingLaunch(false)}
                disabled={isSubmitting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <Cancel01Icon size={14} /> Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void executeLaunch()}
                disabled={isSubmitting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {isSubmitting ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RocketIcon size={14} />}
                Confirm Launch
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AgentDeploymentGuide;
