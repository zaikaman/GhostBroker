import React from 'react';
import type { AgentState } from '../hooks/useConnectionTelemetry';

export interface AgentConnectionGridProps {
  agents: AgentState[];
}

export function AgentConnectionGrid({ agents }: AgentConnectionGridProps): React.JSX.Element {
  const truncateDid = (did: string) => {
    if (did.length <= 16) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  };

  const getStatusBadge = (status: AgentState['status']) => {
    switch (status) {
      case 'verified':
        return <span className="status-badge secure">Verified</span>;
      case 'verifying':
        return <span className="status-badge processing">Verifying</span>;
      case 'rejected':
        return <span className="status-badge error">Rejected</span>;
      case 'revoked':
        return <span className="status-badge error">Revoked</span>;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
        Active Enclave Agent Sessions ({agents.length})
      </h3>
      {agents.length === 0 ? (
        <div 
          className="card" 
          style={{ 
            textAlign: 'center', 
            color: 'var(--color-text-muted)', 
            padding: 'var(--spacing-lg)',
            borderStyle: 'dashed' 
          }}
        >
          No agents currently onboarded or connecting.
        </div>
      ) : (
        <div 
          style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', 
            gap: 'var(--spacing-md)' 
          }}
        >
          {agents.map((agent) => (
            <div 
              key={agent.agentDid}
              className="card" 
              style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                gap: 'var(--spacing-sm)',
                borderColor: agent.connected ? 'rgba(197, 168, 128, 0.3)' : 'var(--color-border)'
              }}
              tabIndex={0}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span 
                  style={{ 
                    fontFamily: 'var(--font-mono)', 
                    fontSize: '0.8rem', 
                    fontWeight: 600,
                    color: 'var(--color-text-primary)' 
                  }}
                  title={agent.agentDid}
                >
                  👤 {truncateDid(agent.agentDid)}
                </span>
                <span 
                  style={{ 
                    fontSize: '0.75rem', 
                    color: agent.connected ? 'var(--color-success)' : 'var(--color-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <span 
                    className={agent.connected ? 'pulse-dot' : ''} 
                    style={{ 
                      width: '6px', 
                      height: '6px', 
                      borderRadius: '50%', 
                      backgroundColor: agent.connected ? 'var(--color-success)' : 'var(--color-text-muted)',
                      display: 'inline-block'
                    }}
                  ></span>
                  {agent.connected ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-xs)' }}>
                {getStatusBadge(agent.status)}
                <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(agent.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {agent.authorityRef && (
                <div 
                  style={{ 
                    marginTop: 'var(--spacing-xs)', 
                    padding: 'var(--spacing-xs) var(--spacing-sm)', 
                    background: 'var(--color-input-bg)', 
                    border: '1px solid var(--color-border)', 
                    borderRadius: 'var(--radius-sm)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.7rem',
                    color: 'var(--color-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={agent.authorityRef}
                >
                  Auth Ref: {agent.authorityRef}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export default AgentConnectionGrid;
