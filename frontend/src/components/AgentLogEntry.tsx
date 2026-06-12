import React from 'react';

export interface AgentLogEntryProps {
  timestamp: string;
  phase: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export function AgentLogEntry({ timestamp, phase, message, severity }: AgentLogEntryProps): React.JSX.Element {
  const getStatusLabel = (p: string) => {
    switch (p) {
      case 'agent_connecting':
      case 'agent_connected':
        return { icon: '🔐', text: 'Authenticating' };
      case 'agent_verifying':
        return { icon: '🔍', text: 'Verifying' };
      case 'agent_verified':
        return { icon: '✅', text: 'Verified' };
      case 'agent_rejected':
        return { icon: '🚫', text: 'Denied' };
      case 'intent_received':
        return { icon: '📥', text: 'Mandate' };
      case 'intent_sealed':
        return { icon: '📦', text: 'Blinded' };
      case 'encrypted_evaluation':
        return { icon: '🧠', text: 'Scanning' };
      case 'settlement_pending':
        return { icon: '💰', text: 'Executing' };
      case 'settlement_finalized':
        return { icon: '✨', text: 'Settled' };
      case 'settlement_failed':
        return { icon: '❌', text: 'Failed' };
      case 'receipt_available':
        return { icon: '📜', text: 'Receipt' };
      default:
        return { icon: '⚡', text: 'System' };
    }
  };

  const status = getStatusLabel(phase);
  
  // Get color depending on severity / phase status
  const getColor = () => {
    if (severity === 'error' || phase.includes('failed') || phase.includes('rejected')) return 'var(--color-error)';
    if (
      phase === 'settlement_finalized' || 
      phase === 'receipt_available' || 
      phase === 'agent_verified'
    ) return 'var(--color-success)';
    return 'var(--color-warning)';
  };

  return (
    <div 
      className="log-entry-item"
      style={{ 
        display: 'flex', 
        alignItems: 'flex-start', 
        gap: 'var(--spacing-sm)', 
        padding: '6px 8px', 
        fontSize: '0.75rem', 
        borderBottom: '1px solid rgba(36, 49, 78, 0.3)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.4,
        color: 'var(--color-text-secondary)',
        minHeight: '26px',
        boxSizing: 'border-box'
      }}
    >
      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
        [{timestamp}]
      </span>
      <span 
        style={{ 
          color: getColor(), 
          fontWeight: 600, 
          display: 'inline-flex', 
          alignItems: 'center', 
          gap: '2px',
          flexShrink: 0,
          background: 'rgba(255, 255, 255, 0.02)',
          padding: '1px 6px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          fontSize: '0.7rem'
        }}
      >
        {status.icon} {status.text}
      </span>
      <span style={{ flexGrow: 1, wordBreak: 'break-word', color: 'var(--color-text-secondary)', marginLeft: '4px' }}>
        {message}
      </span>
    </div>
  );
}

export default AgentLogEntry;
