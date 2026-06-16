import React from 'react';
import type { ProcessingIntent } from '../hooks/useConnectionTelemetry';
import { getTelemetryLabel } from '../services/telemetry-labels';
import {
  Download01Icon,
  LockIcon,
  BrainIcon,
  Clock01Icon,
  CheckmarkCircle01Icon,
  CancelCircleIcon,
  Activity01Icon,
  CpuIcon,
  Shield01Icon
} from 'hugeicons-react';

export interface ProcessingStatusRailProps {
  intents: ProcessingIntent[];
}

export function ProcessingStatusRail({ intents }: ProcessingStatusRailProps): React.JSX.Element {
  const truncateDid = (did: string) => {
    if (did.length <= 16) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  };

  const getStatusColorClass = (statusType: 'success' | 'warning' | 'error' | 'info') => {
    switch (statusType) {
      case 'success':
        return 'secure';
      case 'warning':
        return 'processing';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  };

  const getPhaseIcon = (phase: string) => {
    switch (phase) {
      case 'intent_received':
        return <Download01Icon size={12} />;
      case 'intent_sealed':
        return <LockIcon size={12} />;
      case 'encrypted_evaluation':
        return <BrainIcon size={12} />;
      case 'settlement_pending':
        return <Clock01Icon size={12} />;
      case 'settlement_finalized':
        return <CheckmarkCircle01Icon size={12} />;
      case 'settlement_failed':
        return <CancelCircleIcon size={12} />;
      default:
        return <Activity01Icon size={12} />;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <CpuIcon size={16} style={{ color: 'var(--color-accent)' }} /> Active Cryptographic Processing
      </h3>

      {intents.length === 0 ? (
        <div 
          style={{ 
            textAlign: 'center', 
            color: 'var(--color-text-muted)', 
            padding: 'var(--spacing-xl)',
            border: '1px dashed var(--color-border)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            background: 'var(--color-input-bg)',
            gap: 'var(--spacing-sm)'
          }}
        >
          <Shield01Icon size={28} style={{ opacity: 0.5, color: 'var(--color-text-muted)' }} />
          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.9rem' }}>
            Secure event pipeline active
          </div>
          <div style={{ fontSize: '0.8rem' }}>
            Waiting for encrypted order signals...
          </div>
        </div>
      ) : (
        <div 
          style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: 'var(--spacing-sm)',
            maxHeight: '400px',
            overflowY: 'auto',
            paddingRight: '6px'
          }}
        >
          {intents.map((intent) => {
            const labelInfo = getTelemetryLabel(intent.phase);
            const statusClass = getStatusColorClass(labelInfo.statusType);

            return (
              <div 
                key={intent.correlationRef}
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: 'var(--spacing-sm)',
                  padding: 'var(--spacing-sm) 0',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.03)'
                }}
                tabIndex={0}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span 
                      style={{ 
                        fontFamily: 'var(--font-mono)', 
                        fontSize: '0.8rem', 
                        fontWeight: 600,
                        color: 'var(--color-text-primary)' 
                      }}
                      title={intent.correlationRef}
                    >
                      Handle: {intent.correlationRef}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      Agent: {truncateDid(intent.agentDid)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                    <span className={`status-badge ${statusClass}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span className="pulse-dot"></span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: '2px' }}>{getPhaseIcon(intent.phase)}</span> {labelInfo.label}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {new Date(intent.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
                
                <div 
                  style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--color-text-secondary)',
                    background: 'var(--color-input-bg)',
                    padding: 'var(--spacing-sm)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)'
                  }}
                >
                  {labelInfo.description}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ProcessingStatusRail;
