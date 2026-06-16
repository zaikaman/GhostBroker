import React, { useState } from 'react';
import type { AgentState } from '../hooks/useConnectionTelemetry';
import { UserIcon, Activity01Icon, RocketIcon } from 'hugeicons-react';
import { Pagination } from './Pagination';

export interface AgentConnectionGridProps {
  agents: AgentState[];
  onDeploy?: () => void;
}

export function AgentConnectionGrid({ agents, onDeploy }: AgentConnectionGridProps): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

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

  const totalPages = Math.ceil(agents.length / itemsPerPage);
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedAgents = agents.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Active Enclave Agent Sessions ({agents.length})
        </h3>
        <button
          type="button"
          className="btn-grid-header-deploy"
          onClick={onDeploy}
          title="Open hosted agent controls"
        >
          <RocketIcon size={10} /> + Deploy
        </button>
      </div>
      {agents.length === 0 ? (
        <div 
          style={{ 
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center', 
            gap: 'var(--spacing-sm)',
            padding: 'var(--spacing-xl) var(--spacing-md)',
            border: '1px dashed rgba(94, 210, 156, 0.2)',
            borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(180deg, rgba(15, 21, 36, 0.4) 0%, rgba(11, 15, 25, 0.6) 100%)',
            boxShadow: 'inset 0 0 10px rgba(94, 210, 156, 0.01)'
          }}
        >
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'rgba(94, 210, 156, 0.05)',
            border: '1px solid rgba(94, 210, 156, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '4px',
            animation: 'pulse-animation 3s infinite'
          }}>
            <RocketIcon size={18} style={{ color: 'var(--color-accent)' }} />
          </div>
          <h4 style={{ 
            fontFamily: 'var(--font-mono)', 
            fontSize: '0.75rem', 
            color: 'var(--color-text-primary)',
            letterSpacing: '0.05em',
            margin: 0
          }}>
            NO ENCLAVE AGENT ACTIVE
          </h4>
          <p style={{ 
            fontSize: '0.7rem', 
            color: 'var(--color-text-secondary)', 
            lineHeight: '1.4',
            maxWidth: '220px',
            margin: 0
          }}>
            GhostBroker is an agent-only dark pool. Launch a hosted secure enclave runtime to submit intents.
          </p>
          <button 
            type="button"
            className="btn btn-primary"
            onClick={onDeploy}
            style={{ 
              marginTop: '8px', 
              fontSize: '0.7rem', 
              padding: '6px 12px',
              fontFamily: 'var(--font-mono)',
              width: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            Open Hosted Console
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          {paginatedAgents.map((agent) => (
            <div 
              key={agent.agentDid}
              style={{ 
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                padding: 'var(--spacing-sm) 0',
                borderBottom: '1px solid rgba(255, 255, 255, 0.03)'
              }}
              tabIndex={0}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span 
                  style={{ 
                    fontFamily: 'var(--font-mono)', 
                    fontSize: '0.8rem', 
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  title={agent.agentDid}
                >
                  <UserIcon size={12} style={{ color: 'var(--color-accent)' }} /> {truncateDid(agent.agentDid)}
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2px' }}>
                {getStatusBadge(agent.status)}
                <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(agent.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {agent.authorityRef && (
                <div 
                  style={{ 
                    marginTop: '2px', 
                    padding: '2px 8px', 
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

          <Pagination
            currentPage={activePage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            totalItems={agents.length}
            itemsPerPage={itemsPerPage}
          />
        </div>
      )}
    </div>
  );
}
export default AgentConnectionGrid;
