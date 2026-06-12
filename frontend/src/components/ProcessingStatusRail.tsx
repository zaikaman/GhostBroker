import React from 'react';
import type { ProcessingIntent } from '../hooks/useConnectionTelemetry';
import { getTelemetryLabel } from '../services/telemetry-labels';

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
        return '📥';
      case 'intent_sealed':
        return '🔒';
      case 'encrypted_evaluation':
        return '🧠';
      case 'settlement_pending':
        return '⏳';
      case 'settlement_finalized':
        return '✅';
      case 'settlement_failed':
        return '❌';
      default:
        return '⚡';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>⚡</span> Active Cryptographic Processing
      </h3>

      {intents.length === 0 ? (
        <div 
          className="card" 
          style={{ 
            textAlign: 'center', 
            color: 'var(--color-text-muted)', 
            padding: 'var(--spacing-xl)',
            borderStyle: 'dashed',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--spacing-sm)'
          }}
        >
          <div style={{ fontSize: '1.5rem', opacity: 0.7 }}>🛡️</div>
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
            gap: 'var(--spacing-sm)' 
          }}
        >
          {intents.map((intent) => {
            const labelInfo = getTelemetryLabel(intent.phase);
            const statusClass = getStatusColorClass(labelInfo.statusType);

            return (
              <div 
                key={intent.correlationRef}
                className="card" 
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: 'var(--spacing-sm)',
                  borderLeftWidth: '4px',
                  borderLeftColor: `var(--color-${labelInfo.statusType === 'info' ? 'text-secondary' : labelInfo.statusType})`
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
                      {getPhaseIcon(intent.phase)} {labelInfo.label}
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
