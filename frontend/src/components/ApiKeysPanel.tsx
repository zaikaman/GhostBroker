import React, { useCallback, useEffect, useState } from 'react';
import { apiClient, type ApiKey, type CreatedApiKey } from '../services/api-client';
import { Key01Icon, Copy01Icon, Delete02Icon, PlusSignIcon, CheckmarkCircle01Icon, AlertCircleIcon, Loading03Icon } from 'hugeicons-react';
import { Pagination } from './Pagination';

export function ApiKeysPanel(): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  const loadKeys = useCallback(async (): Promise<ApiKey[]> => {
    return await apiClient.listApiKeys();
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
    });

    loadKeys()
      .then((data) => {
        if (cancelled) return;
        setKeys(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load API keys.';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [loadKeys]);

  const handleCreate = async () => {
    if (!newLabel.trim()) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await apiClient.createApiKey(newLabel.trim());
      setCreatedKey(result);
      setNewLabel('');
      setShowCreateForm(false);
      await loadKeys();
      setCurrentPage(1); // Reset to page 1 on new key generation
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setError(null);
    try {
      await apiClient.revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key.');
    }
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {
      // Fallback: select the text manually
    });
    setCopiedIndex(key);
    setTimeout(() => setCopiedIndex(null), 2500);
  };

  const handleDismissCreated = () => {
    setCreatedKey(null);
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

  const totalPages = Math.ceil(keys.length / itemsPerPage);
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedKeys = keys.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  return (
    <div id="api-keys-panel" className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
          <Key01Icon size={18} style={{ color: 'var(--color-accent)' }} /> API Keys
        </h2>
        <button
          type="button"
          className="btn btn-primary"
          style={{ padding: '6px 12px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          onClick={() => {
            setShowCreateForm(true);
            setCreatedKey(null);
          }}
          disabled={showCreateForm}
        >
          <PlusSignIcon size={14} /> Generate Key
        </button>
      </div>

      {/* Created Key Reveal — shown once after generation */}
      {createdKey && (
        <div style={{
          background: 'rgba(16, 185, 129, 0.08)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--spacing-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-sm)',
          animation: 'fadeIn 0.3s ease',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-success)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
            <CheckmarkCircle01Icon size={16} />
            <strong>KEY GENERATED — COPY IT NOW. IT WILL NOT BE SHOWN AGAIN.</strong>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-xs)',
            background: 'var(--color-input-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--spacing-sm) var(--spacing-md)',
          }}>
            <code style={{
              flex: 1,
              fontSize: '0.75rem',
              color: 'var(--color-accent)',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}>
              {createdKey.key}
            </code>
            <button
              type="button"
              className="btn-grid-header-deploy"
              onClick={() => handleCopyKey(createdKey.key)}
              style={{ flexShrink: 0, padding: '4px 8px' }}
              title="Copy to clipboard"
            >
              {copiedIndex === createdKey.key ? (
                <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)' }} />
              ) : (
                <Copy01Icon size={14} />
              )}
            </button>
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
            Label: {createdKey.label} — Scopes: {createdKey.scopes.join(', ')}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '4px 12px', fontSize: '0.7rem', alignSelf: 'flex-end' }}
            onClick={handleDismissCreated}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create Form */}
      {showCreateForm && !createdKey && (
        <div style={{
          background: 'var(--color-input-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--spacing-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-md)',
        }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Key Label</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. Production Buy Agent"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={100}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) handleCreate(); }}
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '4px 12px', fontSize: '0.7rem' }}
              onClick={() => { setShowCreateForm(false); setNewLabel(''); }}
              disabled={isGenerating}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 12px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}
              onClick={handleCreate}
              disabled={!newLabel.trim() || isGenerating}
            >
              {isGenerating ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {/* Keys List */}
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>
          <Loading03Icon size={20} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : error ? (
        <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-md)' }}>
          <AlertCircleIcon size={14} /> {error}
        </div>
      ) : keys.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: 'var(--spacing-xl)',
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-md)',
        }}>
          No API keys generated yet. Keys allow agents to authenticate without re-signing DID challenges.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          {paginatedKeys.map((key) => (
            <div
              key={key.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--spacing-md)',
                padding: 'var(--spacing-sm) var(--spacing-md)',
                background: 'var(--color-input-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.75rem',
                transition: 'border-color var(--transition-fast)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.8rem' }}>
                    {key.label}
                  </span>
                  <code style={{
                    color: 'var(--color-accent)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.65rem',
                    background: 'rgba(94, 210, 156, 0.08)',
                    padding: '1px 6px',
                    borderRadius: '3px',
                  }}>
                    {key.prefix}...
                  </code>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: 'var(--color-text-muted)', fontSize: '0.65rem' }}>
                  <span>Created {formatDate(key.createdAt)}</span>
                  <span>·</span>
                  <span>{key.scopes.join(', ')}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn-grid-header-deploy"
                onClick={() => {
                  if (window.confirm(`Revoke API key "${key.label}"? This action cannot be undone.`)) {
                    handleRevoke(key.id);
                  }
                }}
                title="Revoke key"
                style={{ color: 'var(--color-error)', borderColor: 'rgba(244, 63, 94, 0.3)', flexShrink: 0 }}
              >
                <Delete02Icon size={14} />
              </button>
            </div>
          ))}

          <Pagination
            currentPage={activePage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            totalItems={keys.length}
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
