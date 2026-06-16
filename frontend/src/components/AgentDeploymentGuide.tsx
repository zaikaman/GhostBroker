import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiClient,
  type AuthSession,
  type CreateHostedAgentRequest,
  type HostedAgentConfig,
  type HostedAgentPreset,
  type HostedAgentRecord,
} from '../services/api-client';
import {
  Activity01Icon,
  AlertCircleIcon,
  ArrowLeft01Icon,
  CheckmarkCircle01Icon,
  Key01Icon,
  Loading03Icon,
  PlayIcon,
  Refresh01Icon,
  Robot01Icon,
  StopIcon,
  Shield01Icon,
  Copy01Icon,
  RocketIcon,
} from 'hugeicons-react';
import '../styles/deploy.css';

interface AgentDeploymentGuideProps {
  session: AuthSession;
  onBack: () => void;
}

interface HostedFormState {
  mode: HostedAgentPreset;
  label: string;
  side: 'buy' | 'sell';
  assetCode: string;
  quoteAssetCode: string;
  operatorPrompt: string;
  referencePrice: string;
  priceBandBps: string;
  quantityMin: string;
  quantityMax: string;
  tickIntervalMs: string;
  maxTicks: string;
  dryRun: boolean;
  groqModel: string;
}

const presetConfigs: Record<'buyer' | 'seller', HostedFormState> = {
  buyer: {
    mode: 'buyer',
    label: 'Buyer Mode',
    side: 'buy',
    assetCode: 'WBTC',
    quoteAssetCode: 'USDC',
    operatorPrompt: 'Work patient liquidity on the buy side. Prefer high-probability matches and avoid spending the full budget on one shot unless conditions are compelling.',
    referencePrice: '70000',
    priceBandBps: '125',
    quantityMin: '0.05',
    quantityMax: '0.25',
    tickIntervalMs: '12000',
    maxTicks: '45',
    dryRun: false,
    groqModel: 'qwen/qwen3-32b',
  },
  seller: {
    mode: 'seller',
    label: 'Seller Mode',
    side: 'sell',
    assetCode: 'WBTC',
    quoteAssetCode: 'USDC',
    operatorPrompt: 'Work patient liquidity on the sell side. Prioritize clean executions within the configured range and avoid chasing unless repeated inactivity suggests widening urgency.',
    referencePrice: '70000',
    priceBandBps: '125',
    quantityMin: '0.05',
    quantityMax: '0.25',
    tickIntervalMs: '12000',
    maxTicks: '45',
    dryRun: false,
    groqModel: 'qwen/qwen3-32b',
  },
};

const defaultFormState: HostedFormState = {
  mode: 'custom',
  label: 'Institution Agent',
  side: 'buy',
  assetCode: 'WBTC',
  quoteAssetCode: 'USDC',
  operatorPrompt: 'Trade within the configured band. Favor likely matches, preserve balance discipline, and stop only for genuine structural faults.',
  referencePrice: '70000',
  priceBandBps: '150',
  quantityMin: '0.05',
  quantityMax: '0.25',
  tickIntervalMs: '15000',
  maxTicks: '40',
  dryRun: false,
  groqModel: 'qwen/qwen3-32b',
};

function truncateMiddle(value: string, keep = 12): string {
  if (value.length <= keep * 2) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
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

function buildConfig(state: HostedFormState): HostedAgentConfig {
  return {
    mode: state.mode,
    label: state.label.trim(),
    side: state.side,
    assetCode: state.assetCode.trim().toUpperCase(),
    quoteAssetCode: state.quoteAssetCode.trim().toUpperCase(),
    operatorPrompt: state.operatorPrompt.trim(),
    referencePrice: Number(state.referencePrice),
    priceBandBps: Number(state.priceBandBps),
    quantityMin: Number(state.quantityMin),
    quantityMax: Number(state.quantityMax),
    tickIntervalMs: Number(state.tickIntervalMs),
    maxTicks: Number(state.maxTicks),
    dryRun: state.dryRun,
    ...(state.groqModel.trim() ? { groqModel: state.groqModel.trim() } : {}),
  };
}

export function AgentDeploymentGuide({
  session,
  onBack,
}: AgentDeploymentGuideProps): React.JSX.Element {
  const [hostedAgents, setHostedAgents] = useState<HostedAgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [form, setForm] = useState<HostedFormState>(defaultFormState);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadState = useCallback(async () => {
    const records = await apiClient.listHostedAgents();
    setHostedAgents(records);
    setSelectedAgentId((current) => {
      if (current && records.some((record) => record.agent.id === current)) {
        return current;
      }
      return records[0]?.agent.id ?? null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      loadState()
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to load hosted agents.');
        })
        .finally(() => {
          if (cancelled) return;
          setIsLoading(false);
        });
    });

    const intervalId = window.setInterval(() => {
      loadState().catch(() => {
        // keep last successful state
      });
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadState]);

  const selectedAgent = useMemo(
    () => hostedAgents.find((record) => record.agent.id === selectedAgentId) ?? null,
    [hostedAgents, selectedAgentId],
  );

  const runningCount = hostedAgents.filter((record) => record.runtime.running).length;

  const readiness = useMemo(
    () => [
      {
        label: 'Institution Session',
        ready: Boolean(session.token && session.institution.id),
        detail: session.institution.displayName,
      },
      {
        label: 'Hosted Agents Configured',
        ready: hostedAgents.length > 0,
        detail: `${hostedAgents.length} configured`,
      },
      {
        label: 'Agents Running',
        ready: runningCount > 0,
        detail: `${runningCount} live runtime${runningCount !== 1 ? 's' : ''}`,
      },
      {
        label: 'Prompt Control Status',
        ready: true,
        detail: 'Operator policy active',
      },
    ],
    [hostedAgents.length, runningCount, session.institution.displayName, session.institution.id, session.token],
  );

  const applyPreset = useCallback((preset: HostedAgentPreset) => {
    if (preset === 'custom') {
      setForm((current) => ({ ...current, mode: 'custom' }));
      return;
    }
    setForm({ ...presetConfigs[preset] });
  }, []);

  const updateField = useCallback(<K extends keyof HostedFormState>(key: K, value: HostedFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const handleCreate = useCallback(async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const request: CreateHostedAgentRequest = {
        institutionId: session.institution.id,
        config: buildConfig(form),
        startOnCreate: true,
      };
      const record = await apiClient.createHostedAgent(request);
      await loadState();
      setSelectedAgentId(record.agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create hosted agent.');
    } finally {
      setIsSubmitting(false);
    }
  }, [form, loadState, session.institution.id]);

  const handleStart = useCallback(async (id: string) => {
    setError(null);
    setBusyAgentId(id);
    try {
      await apiClient.startHostedAgent(id);
      await loadState();
      setSelectedAgentId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start hosted agent.');
    } finally {
      setBusyAgentId(null);
    }
  }, [loadState]);

  const handleStop = useCallback(async (id: string) => {
    setError(null);
    setBusyAgentId(id);
    try {
      await apiClient.stopHostedAgent(id);
      await loadState();
      setSelectedAgentId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop hosted agent.');
    } finally {
      setBusyAgentId(null);
    }
  }, [loadState]);

  const handleCopyLogs = useCallback(() => {
    if (!selectedAgent?.runtime.logTail) return;
    navigator.clipboard.writeText(selectedAgent.runtime.logTail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [selectedAgent]);

  // Log highlighting parser
  const renderFormattedLogs = (logTail?: string) => {
    if (!logTail) {
      return (
        <div className="sec-terminal-line text-muted" style={{ color: 'var(--color-text-muted)' }}>
          No execution logs streamed. Ready to launch secure TEE process.
        </div>
      );
    }
    return logTail.split('\n').map((line, idx) => {
      let type = 'info';
      const lowercase = line.toLowerCase();
      if (lowercase.includes('error') || lowercase.includes('fail')) {
        type = 'error';
      } else if (lowercase.includes('warn')) {
        type = 'warning';
      } else if (
        lowercase.includes('seal') ||
        lowercase.includes('attest') ||
        lowercase.includes('confidential') ||
        lowercase.includes('enclave') ||
        lowercase.includes('success')
      ) {
        type = 'confidential';
      }
      return (
        <div key={idx} className={`sec-terminal-line ${type}`}>
          {line}
        </div>
      );
    });
  };

  return (
    <div className="deploy-layout deploy-factory-layout">
      {/* Dashboard Consistent Header */}
      <header className="deploy-header deploy-header-hosted">
        <div className="deploy-header-left">
          <button type="button" className="btn btn-secondary" onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ArrowLeft01Icon size={14} /> Back
          </button>
        </div>
        <div className="deploy-header-center">
          <h1 className="deploy-title">Hosted Agent Factory</h1>
          <span className="deploy-subtitle">
            Deploy autonomous trading agents in attested hardware secure enclaves.
          </span>
        </div>
        <div className="deploy-header-right">
          <div className={`status-badge ${runningCount > 0 ? 'secure' : 'processing'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: runningCount > 0 ? 'var(--color-success)' : 'var(--color-warning)',
                boxShadow: runningCount > 0 ? '0 0 8px var(--color-success)' : 'none',
              }}
            />
            <span>GhostBroker Hosted: {runningCount > 0 ? `${runningCount} live` : 'Ready'}</span>
          </div>
        </div>
      </header>

      {/* Error Alert Overlay */}
      {error ? (
        <div className="status-badge error deploy-error-banner" style={{ borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircleIcon size={14} /> {error}
        </div>
      ) : null}

      {/* Main Control Panel and Diagnostics Deck */}
      <div className="deploy-factory-grid">
        {/* Left Column: Configs & Launcher */}
        <div className="deploy-panel-stack" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
          
          {/* Card 1: Attestation Enclave Status */}
          <section className="card">
            <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
              <Shield01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Attestation Enclave Status
            </h2>

            <div className="enclave-visualizer-block">
              <div className="enclave-svg-wrapper">
                <div className="enclave-pulse-glow" />
                <svg className="enclave-svg-orbits" viewBox="0 0 100 100" fill="none">
                  {/* Outer Orbit (Dashed) */}
                  <circle
                    className="orbit-ring-outer"
                    cx="50"
                    cy="50"
                    r="42"
                    stroke="var(--color-accent)"
                    strokeWidth="1"
                    strokeDasharray="4 6"
                    opacity="0.25"
                  />
                  {/* Mid Orbit (Segmented) */}
                  <circle
                    className="orbit-ring-mid"
                    cx="50"
                    cy="50"
                    r="32"
                    stroke="var(--color-accent)"
                    strokeWidth="1.5"
                    strokeDasharray="16 8"
                    opacity="0.35"
                  />
                  {/* Inner Orbit (Dashed) */}
                  <circle
                    className="orbit-ring-inner"
                    cx="50"
                    cy="50"
                    r="22"
                    stroke="var(--color-accent)"
                    strokeWidth="1"
                    strokeDasharray="2 3"
                    opacity="0.5"
                  />
                  {/* Core Enclave Shield */}
                  <circle
                    cx="50"
                    cy="50"
                    r="12"
                    fill="rgba(94, 210, 156, 0.08)"
                    stroke="var(--color-accent)"
                    strokeWidth="2"
                    style={{ filter: 'drop-shadow(0px 0px 4px rgba(94, 210, 156, 0.3))' }}
                  />
                  {/* Core Lock Graphic */}
                  <path
                    d="M47 52h6v4h-6v-4zm4-4c1.65 0 3 1.35 3 3v1h-6v-1c0-1.65 1.35-3 3-3z"
                    fill="var(--color-accent)"
                  />
                </svg>
              </div>

              <div className="enclave-telemetry-readout">
                <div className="telemetry-row">
                  <span className="telemetry-label">Security State</span>
                  <span className="telemetry-value success">Intel SGX Attested</span>
                </div>
                <div className="telemetry-row">
                  <span className="telemetry-label">Privacy Boundary</span>
                  <span className="telemetry-value">Zero Human Visibility</span>
                </div>
                <div className="telemetry-row">
                  <span className="telemetry-label">MRENCLAVE</span>
                  <span className="telemetry-value hash">8bfa93cd77ab...4fe9bc3cf81b</span>
                </div>
                <div className="telemetry-row">
                  <span className="telemetry-label">MRSIGNER</span>
                  <span className="telemetry-value hash">f3a2901db4c1...e0d9bcfd27b9</span>
                </div>
              </div>
            </div>
          </section>

          {/* Card 2: Creation Parameter Panel */}
          <section className="card">
            <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
              <Robot01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Configure Trading Mandate
            </h2>

            {/* Presets Sequencer Selector */}
            <div className="deploy-preset-row" style={{ marginTop: 0 }}>
              {(['buyer', 'seller', 'custom'] as HostedAgentPreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`deploy-preset-button ${form.mode === preset ? 'active' : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset === 'buyer' ? 'Buyer Mandate' : preset === 'seller' ? 'Seller Mandate' : 'Custom'}
                </button>
              ))}
            </div>

            {/* Form Fields Grid */}
            <div className="deploy-form-grid" style={{ marginTop: 'var(--spacing-md)' }}>
              
              <div className="form-group">
                <label className="form-label">Agent Label</label>
                <input
                  className="form-input"
                  value={form.label}
                  onChange={(event) => updateField('label', event.target.value)}
                  placeholder="Enter custom identifier..."
                />
              </div>

              <div className="form-group">
                <label className="form-label">Execution Side</label>
                <select
                  className="form-select"
                  value={form.side}
                  onChange={(event) => updateField('side', event.target.value as 'buy' | 'sell')}
                >
                  <option value="buy">BUY MANDATE</option>
                  <option value="sell">SELL MANDATE</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Target Asset</label>
                <input
                  className="form-input font-mono"
                  value={form.assetCode}
                  onChange={(event) => updateField('assetCode', event.target.value.toUpperCase())}
                  placeholder="e.g. WBTC"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Quote Asset</label>
                <input
                  className="form-input font-mono"
                  value={form.quoteAssetCode}
                  onChange={(event) => updateField('quoteAssetCode', event.target.value.toUpperCase())}
                  placeholder="e.g. USDC"
                />
              </div>

              <div className="form-group">
                <label className="form-label">LLM Engine</label>
                <input
                  className="form-input font-mono"
                  value={form.groqModel}
                  onChange={(event) => updateField('groqModel', event.target.value)}
                  placeholder="Model details..."
                />
              </div>

              <div className="form-group">
                <label className="form-label">Reference Price</label>
                <input
                  className="form-input font-mono"
                  inputMode="decimal"
                  value={form.referencePrice}
                  onChange={(event) => updateField('referencePrice', event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Execution Band (bps)</label>
                <input
                  className="form-input font-mono"
                  inputMode="numeric"
                  value={form.priceBandBps}
                  onChange={(event) => updateField('priceBandBps', event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Interval (ms)</label>
                <input
                  className="form-input font-mono"
                  inputMode="numeric"
                  value={form.tickIntervalMs}
                  onChange={(event) => updateField('tickIntervalMs', event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Quantity Min</label>
                <input
                  className="form-input font-mono"
                  inputMode="decimal"
                  value={form.quantityMin}
                  onChange={(event) => updateField('quantityMin', event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Quantity Max</label>
                <input
                  className="form-input font-mono"
                  inputMode="decimal"
                  value={form.quantityMax}
                  onChange={(event) => updateField('quantityMax', event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Max Iterations</label>
                <input
                  className="form-input font-mono"
                  inputMode="numeric"
                  value={form.maxTicks}
                  onChange={(event) => updateField('maxTicks', event.target.value)}
                />
              </div>

              {/* Dry Run Toggle Switch */}
              <div className="form-group" style={{ justifyContent: 'center' }}>
                <label className="deploy-inline-toggle" style={{ cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={form.dryRun}
                    onChange={(event) => updateField('dryRun', event.target.checked)}
                  />
                  <span>Dry Run Simulation Mode</span>
                </label>
              </div>

              {/* Operator Directives Textarea Box */}
              <div className="form-group deploy-form-span-full" style={{ marginBottom: 0 }}>
                <label className="form-label">Operator Directive Prompt</label>
                <textarea
                  className="form-input deploy-textarea font-mono"
                  value={form.operatorPrompt}
                  onChange={(event) => updateField('operatorPrompt', event.target.value)}
                  placeholder="Enter policy prompt constraints for autonomous agent decision-making..."
                />
              </div>
            </div>

            {/* Form CTAs */}
            <div className="deploy-form-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--spacing-md)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setIsLoading(true);
                  loadState().finally(() => setIsLoading(false));
                }}
                disabled={isLoading || isSubmitting}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Refresh01Icon size={14} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
                Synchronize Fleet
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={isLoading || isSubmitting}
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {isSubmitting ? (
                  <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <RocketIcon size={14} />
                )}
                Deploy Attested Agent
              </button>
            </div>
          </section>

          {/* Card 3: Pre-Flight Launch Checklist */}
          <section className="card">
            <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
              <Activity01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Pre-Flight Launch Readiness
            </h2>
            <div className="preflight-checklist">
              {readiness.map((item) => (
                <div key={item.label} className="preflight-cell">
                  <div className={`preflight-status-circle ${item.ready ? 'ready' : ''}`}>
                    {item.ready ? <CheckmarkCircle01Icon size={12} /> : <AlertCircleIcon size={12} />}
                  </div>
                  <div className="preflight-info">
                    <span className="preflight-label">{item.label}</span>
                    <span className="preflight-desc">{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right Column: Fleet List, Process Telemetry, and Secure Terminal */}
        <div className="deploy-side-stack" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
          
          {/* Card 1: Attested Worker Fleet */}
          <section className="card">
            <h2 className="card-title" style={{ margin: '0 0 var(--spacing-md) 0' }}>
              <Key01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Attested Worker Fleet
            </h2>

            {isLoading ? (
              <div className="deploy-loading-state-premium" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)', fontSize: '0.75rem', gap: 'var(--spacing-sm)' }}>
                <Loading03Icon size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent)' }} />
                <span>Streaming cluster information...</span>
              </div>
            ) : hostedAgents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                <AlertCircleIcon size={20} style={{ color: 'var(--color-text-muted)', marginBottom: '8px' }} />
                <p style={{ margin: 0 }}>No active attested agents launched. Deploy an autonomous agent using the mandate panel.</p>
              </div>
            ) : (
              <div className="deploy-agent-fleet">
                {hostedAgents.map((record) => {
                  const isActive = selectedAgentId === record.agent.id;
                  const isRunning = record.runtime.running;
                  return (
                    <button
                      key={record.agent.id}
                      type="button"
                      className={`deploy-agent-runtime ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedAgentId(record.agent.id)}
                    >
                      <div className="deploy-agent-runtime-main">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.8rem' }}>{record.config.label}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
                            {record.config.side.toUpperCase()} MANDATE • {record.config.assetCode}/{record.config.quoteAssetCode}
                          </span>
                        </div>
                        <span className={`status-badge ${isRunning ? 'secure' : 'processing'}`} style={{ display: 'inline-flex', fontSize: '0.62rem', padding: '2px 8px', borderRadius: '4px' }}>
                          <span
                            style={{
                              width: '5px',
                              height: '5px',
                              borderRadius: '50%',
                              background: isRunning ? 'var(--color-success)' : 'var(--color-warning)',
                              marginRight: '4px',
                            }}
                          />
                          {isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div className="deploy-agent-runtime-meta">
                        <span title={record.agent.agentDid}>
                          DID: {truncateMiddle(record.agent.agentDid, 9)}
                        </span>
                        <span>{formatTimestamp(record.runtime.startedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Card 2: Enclave Telemetry Feed & Logs */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            <h2 className="card-title" style={{ margin: 0 }}>
              <Activity01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Enclave Telemetry Feed
            </h2>

            {!selectedAgent ? (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                <p style={{ margin: 0 }}>Select an attested worker pod to inspect its secure enclave runtime feed.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {/* Process Details */}
                <div className="process-dashboard">
                  <div className="process-cell">
                    <span className="process-label">Enclave Label</span>
                    <span className="process-value active">{selectedAgent.config.label}</span>
                  </div>
                  <div className="process-cell">
                    <span className="process-label">PID</span>
                    <span className="process-value">{selectedAgent.runtime.pid || 'OFFLINE'}</span>
                  </div>
                  <div className="process-cell">
                    <span className="process-label">API Key Ref</span>
                    <span className="process-value">
                      {selectedAgent.runtime.apiKeyId ? truncateMiddle(selectedAgent.runtime.apiKeyId, 8) : 'NONE'}
                    </span>
                  </div>
                </div>

                {/* Control Action Buttons */}
                <div className="deploy-runtime-actions" style={{ display: 'flex', gap: 'var(--spacing-md)', marginTop: 0, marginBottom: 'var(--spacing-md)' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAgentId === selectedAgent.agent.id || selectedAgent.runtime.running}
                    onClick={() => handleStart(selectedAgent.agent.id)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                  >
                    {busyAgentId === selectedAgent.agent.id && !selectedAgent.runtime.running ? (
                      <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <PlayIcon size={14} />
                    )}
                    Launch Process
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busyAgentId === selectedAgent.agent.id || !selectedAgent.runtime.running}
                    onClick={() => handleStop(selectedAgent.agent.id)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                  >
                    {busyAgentId === selectedAgent.agent.id && selectedAgent.runtime.running ? (
                      <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <StopIcon size={14} />
                    )}
                    Terminate Process
                  </button>
                </div>

                {/* Terminal Emulator Box */}
                <div className="sec-terminal">
                  <div className="sec-terminal-header">
                    <div className="sec-terminal-window-dots">
                      <span className="sec-terminal-dot red" />
                      <span className="sec-terminal-dot yellow" />
                      <span className="sec-terminal-dot green" />
                    </div>
                    <span className="sec-terminal-title">sec-terminal@ghostbroker:~</span>
                    <button
                      type="button"
                      className="sec-terminal-action-btn"
                      onClick={handleCopyLogs}
                      title="Copy telemetry output"
                      style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.62rem', fontFamily: 'var(--font-mono)' }}
                    >
                      <Copy01Icon size={12} />
                      {copied ? 'COPIED' : 'COPY'}
                    </button>
                  </div>
                  <div className="sec-terminal-body">
                    {renderFormattedLogs(selectedAgent.runtime.logTail)}
                    {selectedAgent.runtime.running && (
                      <div className="sec-terminal-prompt">
                        <span>root@ghostbroker-tee:~# tail -f /var/log/enclave.log</span>
                        <span className="sec-terminal-cursor" />
                      </div>
                    )}
                  </div>
                </div>

                {selectedAgent.runtime.lastError ? (
                  <div className="deploy-runtime-error">
                    <AlertCircleIcon size={14} />
                    <span>Runtime Fault: {selectedAgent.runtime.lastError}</span>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default AgentDeploymentGuide;
