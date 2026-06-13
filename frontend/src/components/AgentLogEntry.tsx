import React from 'react';
import {
  LockIcon,
  Search01Icon,
  CheckmarkCircle01Icon,
  CancelCircleIcon,
  Download01Icon,
  LockKeyIcon,
  BrainIcon,
  HourglassIcon,
  ScrollIcon,
  Activity01Icon
} from 'hugeicons-react';

export interface AgentLogEntryProps {
  timestamp: string;
  phase: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export function AgentLogEntry({ timestamp, phase, message, severity }: AgentLogEntryProps): React.JSX.Element {
  const getStatusLabel = (p: string): { icon: React.ReactNode; text: string } => {
    switch (p) {
      case 'agent_connecting':
      case 'agent_connected':
        return { icon: <LockIcon size={12} />, text: 'Authenticating' };
      case 'agent_verifying':
        return { icon: <Search01Icon size={12} />, text: 'Verifying' };
      case 'agent_verified':
        return { icon: <CheckmarkCircle01Icon size={12} />, text: 'Verified' };
      case 'agent_rejected':
        return { icon: <CancelCircleIcon size={12} />, text: 'Denied' };
      case 'intent_received':
        return { icon: <Download01Icon size={12} />, text: 'Mandate' };
      case 'intent_sealed':
        return { icon: <LockKeyIcon size={12} />, text: 'Blinded' };
      case 'encrypted_evaluation':
        return { icon: <BrainIcon size={12} />, text: 'Scanning' };
      case 'settlement_pending':
        return { icon: <HourglassIcon size={12} />, text: 'Executing' };
      case 'settlement_finalized':
        return { icon: <CheckmarkCircle01Icon size={12} />, text: 'Settled' };
      case 'settlement_failed':
        return { icon: <CancelCircleIcon size={12} />, text: 'Failed' };
      case 'receipt_available':
        return { icon: <ScrollIcon size={12} />, text: 'Receipt' };
      default:
        return { icon: <Activity01Icon size={12} />, text: 'System' };
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
          gap: '4px',
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
