import React from 'react';

export function DisclosureTimeline({
  disclosures,
  rationaleByClaim,
}: {
  disclosures: {
    id: string;
    fromSide: string;
    claimType: string;
    verified: boolean;
    createdAt: string;
  }[];
  rationaleByClaim?: Record<string, string>;
}): React.JSX.Element {
  if (disclosures.length === 0) {
    return (
      <div className="card" aria-label="No disclosures" style={{ padding: '16px' }}>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>No verified disclosures yet.</p>
      </div>
    );
  }

  return (
    <div aria-label="Disclosure timeline" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {disclosures.map((disclosure, index) => {
        const rationale =
          rationaleByClaim?.[disclosure.id] ?? rationaleByClaim?.[disclosure.claimType];
        return (
          <div
            key={disclosure.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '18px 1fr',
              gap: '12px',
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100%' }}>
              <span
                aria-label={disclosure.verified ? 'Verified disclosure' : 'Unverified disclosure'}
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  marginTop: '6px',
                  background: disclosure.verified ? 'var(--color-accent)' : '#d6a94c',
                  boxShadow: disclosure.verified
                    ? '0 0 12px rgba(94, 210, 156, 0.35)'
                    : '0 0 10px rgba(214, 169, 76, 0.25)',
                }}
              />
              {index < disclosures.length - 1 ? (
                <span
                  aria-hidden="true"
                  style={{
                    width: '1px',
                    flex: 1,
                    marginTop: '6px',
                    background: 'rgba(255,255,255,0.08)',
                    minHeight: '28px',
                  }}
                />
              ) : null}
            </div>

            <article
              style={{
                border: '1px solid rgba(255,255,255,0.05)',
                background: 'rgba(255,255,255,0.02)',
                borderRadius: '12px',
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <strong style={{ color: 'var(--color-text-primary)', fontSize: '0.85rem' }}>{disclosure.claimType}</strong>
                <span
                  style={{
                    color: disclosure.verified ? 'var(--color-accent)' : '#d6a94c',
                    fontSize: '0.72rem',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {disclosure.verified ? 'Verified' : 'Pending'}
                </span>
              </div>
              <p style={{ margin: '6px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.78rem' }}>
                Revealed by <span style={{ color: 'var(--color-text-primary)' }}>{disclosure.fromSide}</span> ·{' '}
                {new Date(disclosure.createdAt).toLocaleString()}
              </p>
              {rationale && (
                <p
                  style={{
                    margin: '8px 0 0',
                    paddingTop: '8px',
                    borderTop: '1px solid rgba(255,255,255,0.04)',
                    color: 'var(--color-text-muted)',
                    fontSize: '0.72rem',
                    fontStyle: 'italic',
                  }}
                >
                  {rationale}
                </p>
              )}
            </article>
          </div>
        );
      })}
    </div>
  );
}
