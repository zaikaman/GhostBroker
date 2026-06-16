import React, { useCallback, useEffect, useState } from 'react';
import { apiClient, type Agent } from '../services/api-client';
import {
  Robot01Icon,
  CheckmarkCircle01Icon,
  AlertCircleIcon,
  Loading03Icon,
  Edit02Icon,
  Delete02Icon,
  Refresh01Icon,
} from 'hugeicons-react';
import { Pagination } from './Pagination';

export function AgentsPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  const loadAgents = useCallback(async (): Promise<Agent[]> => {
    return await apiClient.listAgents();
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    loadAgents()
      .then((agentList) => {
        if (cancelled) return;
        setAgents(agentList);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load agents.';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadAgents]);

  const handleStartEdit = (agent: Agent) => {
    setEditingLabel(agent.id);
    setEditValue(agent.label || agent.agentDid.slice(0, 24));
  };

  const handleSaveLabel = async (id: string) => {
    if (!editValue.trim()) return;
    setIsSaving(true);
    try {
      const updated = await apiClient.updateAgentLabel(id, editValue.trim());
      setAgents((prev) => prev.map((agent) => (agent.id === id ? updated : agent)));
      setEditingLabel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update label.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingLabel(null);
    setEditValue('');
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await apiClient.revokeAgent(id);
      setAgents((prev) =>
        prev.map((agent) => (agent.id === id ? { ...agent, status: 'revoked' } : agent)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke agent.');
    } finally {
      setRevokingId(null);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const totalPages = Math.ceil(agents.length / itemsPerPage);
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedAgents = agents.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    setExpandedAgentId(null);
  };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
          <Robot01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Registered Agents
        </h2>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: '6px 12px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          onClick={loadAgents}
          disabled={isLoading}
        >
          <Refresh01Icon size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-md)' }}>
          <AlertCircleIcon size={14} /> {error}
        </div>
      )}

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>
          <Loading03Icon size={20} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : agents.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--spacing-xl)',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            border: '1px dashed var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          No agents registered yet. Launch a hosted agent from the Hosted Agents tab to get started.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1.5fr 1fr 1fr auto',
              gap: 'var(--spacing-sm)',
              padding: 'var(--spacing-xs) var(--spacing-md)',
              fontSize: '0.6rem',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontFamily: 'var(--font-mono)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <span>Agent / Label</span>
            <span>DID</span>
            <span>Status</span>
            <span>Registered</span>
            <span style={{ width: '60px' }}>Actions</span>
          </div>

          {paginatedAgents.map((agent) => (
            <React.Fragment key={agent.id}>
              <div
                onClick={() => setExpandedAgentId(expandedAgentId === agent.id ? null : agent.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1.5fr 1fr 1fr auto',
                  gap: 'var(--spacing-sm)',
                  alignItems: 'center',
                  padding: 'var(--spacing-sm) var(--spacing-md)',
                  background: 'var(--color-input-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: expandedAgentId === agent.id ? 'var(--radius-sm) var(--radius-sm) 0 0' : 'var(--radius-sm)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  transition: 'border-color var(--transition-fast)',
                  opacity: agent.status === 'revoked' ? 0.5 : 1,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  {editingLabel === agent.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="text"
                        className="form-input"
                        style={{ padding: '2px 6px', fontSize: '0.75rem', width: '100%' }}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        maxLength={100}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveLabel(agent.id);
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                      />
                      <button
                        type="button"
                        className="btn-grid-header-deploy"
                        onClick={() => handleSaveLabel(agent.id)}
                        disabled={isSaving || !editValue.trim()}
                        style={{ padding: '2px 6px', fontSize: '0.65rem' }}
                      >
                        {isSaving ? '...' : <CheckmarkCircle01Icon size={12} />}
                      </button>
                      <button
                        type="button"
                        className="btn-grid-header-deploy"
                        onClick={handleCancelEdit}
                        style={{ padding: '2px 6px', fontSize: '0.65rem', color: 'var(--color-text-muted)' }}
                      >
                        &#x2716;
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.8rem' }}>
                        {agent.label || 'Unnamed Agent'}
                      </span>
                      {agent.status === 'admitted' && (
                        <button
                          type="button"
                          className="btn-grid-header-deploy"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(agent);
                          }}
                          title="Edit label"
                          style={{ padding: '2px 4px', opacity: 0.5 }}
                        >
                          <Edit02Icon size={10} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <code
                  style={{
                    color: 'var(--color-accent)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.65rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={agent.agentDid}
                >
                  {agent.agentDid.length > 24 ? `${agent.agentDid.slice(0, 22)}...` : agent.agentDid}
                </code>

                <div>
                  <span className={`status-badge ${agent.status === 'admitted' ? 'secure' : 'error'}`} style={{ fontSize: '0.6rem', padding: '2px 8px' }}>
                    {agent.status === 'admitted' ? 'ADMITTED' : 'REVOKED'}
                  </span>
                </div>

                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.65rem' }}>
                  {formatDate(agent.createdAt)}
                </span>

                <div style={{ display: 'flex', gap: '4px', width: '60px', justifyContent: 'flex-end' }}>
                  {agent.status === 'admitted' && (
                    <button
                      type="button"
                      className="btn-grid-header-deploy"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Revoke agent "${agent.label || agent.agentDid}"? This will clear their active intents and they won't be able to submit new ones until re-admitted.`)) {
                          handleRevoke(agent.id);
                        }
                      }}
                      disabled={revokingId === agent.id}
                      title="Revoke agent"
                      style={{ color: 'var(--color-error)', borderColor: 'rgba(244, 63, 94, 0.3)' }}
                    >
                      {revokingId === agent.id ? (
                        <Loading03Icon size={12} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <Delete02Icon size={12} />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {expandedAgentId === agent.id && (
                <div
                  style={{
                    padding: 'var(--spacing-sm) var(--spacing-md)',
                    background: 'rgba(255, 255, 255, 0.01)',
                    border: '1px solid var(--color-border)',
                    borderTop: 'none',
                    borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
                    fontSize: '0.7rem',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 'var(--spacing-sm)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Instruments</div>
                    <code style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                      {agent.instrumentScope?.join(', ') || 'All'}
                    </code>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Direction</div>
                    <code style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                      {agent.directionScope?.join(', ') || 'All'}
                    </code>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Max Notional</div>
                    <code style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                      {agent.maxNotional ? `${(BigInt(agent.maxNotional) / 1000000n).toLocaleString()} units` : 'Unlimited'}
                    </code>
                  </div>
                  {agent.policyHash && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Policy Hash</div>
                      <code style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.6rem', wordBreak: 'break-all' }}>
                        {agent.policyHash}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}

          <Pagination
            currentPage={activePage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            totalItems={agents.length}
            itemsPerPage={itemsPerPage}
          />
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
