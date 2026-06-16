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
  CloudServerIcon,
  Key01Icon,
  Loading03Icon,
  PlayIcon,
  Refresh01Icon,
  Robot01Icon,
  StopIcon,
} from 'hugeicons-react';

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
        label: 'Institution session',
        ready: Boolean(session.token && session.institution.id),
        detail: session.institution.displayName,
      },
      {
        label: 'Hosted agents configured',
        ready: hostedAgents.length > 0,
        detail: `${hostedAgents.length} configured`,
      },
      {
        label: 'Agents running',
        ready: runningCount > 0,
        detail: `${runningCount} live`,
      },
      {
        label: 'Prompt control',
        ready: true,
        detail: 'Operator-defined behavior and parameters',
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

  return (
    <div className="deploy-layout deploy-factory-layout">
      <header className="deploy-header deploy-header-hosted">
        <div className="deploy-header-left">
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            <ArrowLeft01Icon size={14} /> Back
          </button>
        </div>
        <div className="deploy-header-center">
          <h1 className="deploy-title">Hosted Agent Factory</h1>
          <span className="deploy-subtitle">
            GhostBroker hosts institution-defined agents with your prompts, your bounds, and live runtime control.
          </span>
        </div>
        <div className="deploy-header-right">
          <span className={`status-badge ${runningCount > 0 ? 'secure' : 'processing'}`}>
            GhostBroker Hosted: {runningCount > 0 ? `${runningCount} live` : 'Ready'}
          </span>
        </div>
      </header>

      {error ? (
        <div className="status-badge error deploy-error-banner">
          <AlertCircleIcon size={14} /> {error}
        </div>
      ) : null}

      <div className="deploy-factory-grid">
        <section className="deploy-panel-stack">
          <div className="deploy-info-card deploy-factory-intro">
            <div className="deploy-info-header">
              <CloudServerIcon size={16} style={{ color: 'var(--color-accent)' }} />
              Hosted by GhostBroker
            </div>
            <div className="deploy-factory-hero">
              <div className="deploy-factory-copy">
                <h2 className="deploy-step-title">Launch autonomous agents without a VM setup step</h2>
                <p className="deploy-step-desc">
                  Configure a buyer or seller mandate directly in the dashboard. GhostBroker mints the runtime key,
                  provisions the agent identity, runs the process server-side, and streams the runtime log back here.
                </p>
              </div>
              <div className="deploy-factory-meta">
                <div className="deploy-copy-field">
                  <span className="deploy-copy-label">Institution</span>
                  <code className="deploy-copy-value">{session.institution.displayName}</code>
                </div>
                <div className="deploy-copy-field">
                  <span className="deploy-copy-label">Tenant DID</span>
                  <code className="deploy-copy-value">{truncateMiddle(session.institution.t3TenantDid, 14)}</code>
                </div>
                <div className="deploy-copy-field">
                  <span className="deploy-copy-label">Live runtimes</span>
                  <code className="deploy-copy-value">{runningCount}</code>
                </div>
              </div>
            </div>
          </div>

          <div className="deploy-info-card">
            <div className="deploy-info-header">
              <Robot01Icon size={16} style={{ color: 'var(--color-accent)' }} />
              Create hosted agent
            </div>
            <div className="deploy-preset-row">
              {(['buyer', 'seller', 'custom'] as HostedAgentPreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`deploy-preset-button ${form.mode === preset ? 'active' : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset === 'buyer' ? 'Buyer Mode' : preset === 'seller' ? 'Seller Mode' : 'Custom'}
                </button>
              ))}
            </div>

            <div className="deploy-form-grid">
              <label className="form-group">
                <span className="form-label">Agent label</span>
                <input className="form-input" value={form.label} onChange={(event) => updateField('label', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Side</span>
                <select className="form-select" value={form.side} onChange={(event) => updateField('side', event.target.value as 'buy' | 'sell')}>
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </label>
              <label className="form-group">
                <span className="form-label">Asset</span>
                <input className="form-input" value={form.assetCode} onChange={(event) => updateField('assetCode', event.target.value.toUpperCase())} />
              </label>
              <label className="form-group">
                <span className="form-label">Quote asset</span>
                <input className="form-input" value={form.quoteAssetCode} onChange={(event) => updateField('quoteAssetCode', event.target.value.toUpperCase())} />
              </label>
              <label className="form-group">
                <span className="form-label">Reference price</span>
                <input className="form-input" inputMode="decimal" value={form.referencePrice} onChange={(event) => updateField('referencePrice', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Band (bps)</span>
                <input className="form-input" inputMode="numeric" value={form.priceBandBps} onChange={(event) => updateField('priceBandBps', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Quantity min</span>
                <input className="form-input" inputMode="decimal" value={form.quantityMin} onChange={(event) => updateField('quantityMin', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Quantity max</span>
                <input className="form-input" inputMode="decimal" value={form.quantityMax} onChange={(event) => updateField('quantityMax', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Tick interval (ms)</span>
                <input className="form-input" inputMode="numeric" value={form.tickIntervalMs} onChange={(event) => updateField('tickIntervalMs', event.target.value)} />
              </label>
              <label className="form-group">
                <span className="form-label">Max ticks</span>
                <input className="form-input" inputMode="numeric" value={form.maxTicks} onChange={(event) => updateField('maxTicks', event.target.value)} />
              </label>
              <label className="form-group deploy-form-span-2">
                <span className="form-label">Groq model</span>
                <input className="form-input" value={form.groqModel} onChange={(event) => updateField('groqModel', event.target.value)} />
              </label>
              <label className="form-group deploy-form-span-full">
                <span className="form-label">Operator prompt</span>
                <textarea className="form-input deploy-textarea" value={form.operatorPrompt} onChange={(event) => updateField('operatorPrompt', event.target.value)} />
              </label>
            </div>

            <label className="deploy-inline-toggle">
              <input type="checkbox" checked={form.dryRun} onChange={(event) => updateField('dryRun', event.target.checked)} />
              <span>Dry run only</span>
            </label>

            <div className="deploy-hosted-actions deploy-form-actions">
              <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={isLoading || isSubmitting}>
                {isSubmitting ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CloudServerIcon size={14} />}
                Deploy Autonomous Agent
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setIsLoading(true);
                  loadState().finally(() => setIsLoading(false));
                }}
                disabled={isLoading || isSubmitting}
              >
                <Refresh01Icon size={14} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
                Refresh
              </button>
            </div>
          </div>

          <div className="deploy-info-card">
            <div className="deploy-info-header">
              <Activity01Icon size={16} style={{ color: 'var(--color-accent)' }} />
              Launch readiness
            </div>
            <div className="deploy-checklist">
              {readiness.map((item) => (
                <div key={item.label} className="deploy-check-row">
                  <div className="deploy-check-state">
                    {item.ready ? (
                      <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)' }} />
                    ) : (
                      <AlertCircleIcon size={14} style={{ color: 'var(--color-warning)' }} />
                    )}
                  </div>
                  <div className="deploy-check-copy">
                    <span className="deploy-check-label">{item.label}</span>
                    <span className="deploy-check-detail">{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="deploy-side-stack">
          <div className="deploy-info-card">
            <div className="deploy-info-header">
              <Key01Icon size={16} style={{ color: 'var(--color-accent)' }} />
              Hosted fleet
            </div>
            {isLoading ? (
              <div className="deploy-loading-state">
                <Loading03Icon size={18} style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            ) : hostedAgents.length === 0 ? (
              <div className="deploy-empty-state">No hosted agents yet. Deploy the first one from the console on the left.</div>
            ) : (
              <div className="deploy-agent-fleet">
                {hostedAgents.map((record) => (
                  <button
                    key={record.agent.id}
                    type="button"
                    className={`deploy-agent-runtime ${selectedAgentId === record.agent.id ? 'active' : ''}`}
                    onClick={() => setSelectedAgentId(record.agent.id)}
                  >
                    <div className="deploy-agent-runtime-main">
                      <div>
                        <div className="deploy-agent-name">{record.config.label}</div>
                        <div className="deploy-check-detail">{record.config.side.toUpperCase()} {record.config.assetCode}/{record.config.quoteAssetCode}</div>
                      </div>
                      <span className={`status-badge ${record.runtime.running ? 'secure' : 'processing'}`}>
                        {record.runtime.running ? 'Running' : 'Stopped'}
                      </span>
                    </div>
                    <div className="deploy-agent-runtime-meta">
                      <code>{truncateMiddle(record.agent.agentDid, 10)}</code>
                      <span>{formatTimestamp(record.runtime.startedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="deploy-info-card">
            <div className="deploy-info-header">
              <Activity01Icon size={16} style={{ color: 'var(--color-accent)' }} />
              Selected runtime
            </div>
            {!selectedAgent ? (
              <div className="deploy-empty-state">Select a hosted agent to inspect its runtime.</div>
            ) : (
              <>
                <div className="deploy-process-grid">
                  <div className="deploy-process-cell">
                    <span className="deploy-process-label">Agent</span>
                    <code className="deploy-process-value">{selectedAgent.config.label}</code>
                  </div>
                  <div className="deploy-process-cell">
                    <span className="deploy-process-label">PID</span>
                    <code className="deploy-process-value">{selectedAgent.runtime.pid ?? 'Offline'}</code>
                  </div>
                  <div className="deploy-process-cell deploy-process-span">
                    <span className="deploy-process-label">API key</span>
                    <code className="deploy-process-value">{selectedAgent.runtime.apiKeyId ? truncateMiddle(selectedAgent.runtime.apiKeyId, 12) : 'Not issued'}</code>
                  </div>
                </div>
                <div className="deploy-hosted-actions deploy-runtime-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAgentId === selectedAgent.agent.id || selectedAgent.runtime.running}
                    onClick={() => handleStart(selectedAgent.agent.id)}
                  >
                    {busyAgentId === selectedAgent.agent.id && !selectedAgent.runtime.running ? (
                      <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <PlayIcon size={14} />
                    )}
                    Start
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busyAgentId === selectedAgent.agent.id || !selectedAgent.runtime.running}
                    onClick={() => handleStop(selectedAgent.agent.id)}
                  >
                    {busyAgentId === selectedAgent.agent.id && selectedAgent.runtime.running ? (
                      <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <StopIcon size={14} />
                    )}
                    Stop
                  </button>
                </div>
                <div className="deploy-log-grid">
                  <div className="deploy-log-card">
                    <div className="deploy-log-label">Live terminal feed</div>
                    <pre className="deploy-log-body">{selectedAgent.runtime.logTail || 'No logs yet.'}</pre>
                  </div>
                </div>
                {selectedAgent.runtime.lastError ? (
                  <div className="deploy-runtime-error">
                    <AlertCircleIcon size={14} /> {selectedAgent.runtime.lastError}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default AgentDeploymentGuide;
