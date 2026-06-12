import React from 'react';

export interface SecureMetricProps {
  title: string;
  value: string;
  status: 'secure' | 'processing' | 'error';
  subtext?: string;
  icon?: React.ReactNode;
}

export function SecureMetric({ title, value, status, subtext, icon }: SecureMetricProps): React.JSX.Element {
  // Map internal status state to CSS class names
  const badgeClass = status === 'secure' ? 'secure' : status === 'processing' ? 'processing' : 'error';

  return (
    <div 
      className="card" 
      style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        justifyContent: 'space-between',
        gap: 'var(--spacing-sm)',
        minWidth: '220px'
      }}
      tabIndex={0}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="form-label" style={{ margin: 0 }}>{title}</span>
        {icon && <span style={{ color: 'var(--color-accent)', fontSize: '1.2rem' }}>{icon}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)', marginTop: 'var(--spacing-xs)' }}>
        <span 
          className={`status-badge ${badgeClass}`} 
          style={{ 
            alignSelf: 'flex-start',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9rem',
            padding: 'var(--spacing-xs) var(--spacing-md)'
          }}
        >
          <span className="pulse-dot"></span>
          {value}
        </span>
        {subtext && (
          <span 
            style={{ 
              fontSize: '0.75rem', 
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all'
            }}
          >
            {subtext}
          </span>
        )}
      </div>
    </div>
  );
}
