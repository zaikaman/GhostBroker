import React, { useCallback, useEffect, useState } from 'react';
import { apiClient, type NegotiationSession } from '../services/api-client';
import { DisclosureTimeline } from './DisclosureTimeline';

const STATUS_COLORS: Record<NegotiationSession['status'], string> = {
  pairing: '#d6a94c',
  active: 'var(--color-accent)',
  converged: '#4ecdc4',
  settling: '#d6a94c',
  settled: 'var(--color-accent)',
  walked_away: '#e05c5c',
  expired: '#888',
};

const DISTANCE_LABELS: Record<string, string> = {
  crossed: '✓ Crossed',
  near: '◉ Near',
  moderate: '◈ Moderate',
  far: '◇ Far',
};

function deadlineCountdown(deadline: string): string {
  const diff = Date.parse(deadline) - Date.now();
  if (diff <= 0) return 'Expired';
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins > 60) {
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  return `${mins}m ${secs}s`;
}

export function NegotiationRoomPanel(): React.JSX.Element {
  const [sessions, setSessions] = useState<NegotiationSession[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSessions = useCallback(async () => {
    try {
      const result = await apiClient.listNegotiationSessions();
      setSessions(result);
    } catch {
      // Silently retry on next poll
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchSessions();
    });
    const interval = setInterval(() => {
      void fetchSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  if (loading && sessions.length === 0) {
    return (
      <div className="card" style={{ padding: '24px' }}>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.8rem' }}>Loading negotiation sessions...</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="card" style={{ padding: '24px' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--color-text-primary)' }}>
          NEGOTIATION ROOM
        </h3>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.8rem' }}>
          No active negotiation sessions. Submit a mandate and ticket to begin pairing.
        </p>
      </div>
    );
  }

  return (
    <div aria-label="Negotiation room" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <h3 style={{ margin: 0, fontSize: '0.9rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--color-text-primary)' }}>
        NEGOTIATION ROOM
      </h3>

      {sessions.map((session) => {
        const isExpanded = expandedId === session.id;
        return (
          <article
            key={session.id}
            className="card"
            style={{ padding: '16px', cursor: 'pointer', transition: 'border-color 0.15s' }}
            onClick={() => setExpandedId(isExpanded ? null : session.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setExpandedId(isExpanded ? null : session.id);
              }
            }}
            tabIndex={0}
            role="button"
            aria-expanded={isExpanded}
            aria-label={`Negotiation session ${session.assetCode} — ${session.status}`}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  className="status-badge"
                  style={{
                    background: STATUS_COLORS[session.status],
                    color: '#070b0a',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.68rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {session.status.replace('_', ' ')}
                </span>
                <span style={{ color: 'var(--color-text-primary)', fontSize: '0.85rem', fontWeight: 600 }}>
                  {session.assetCode}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                <span>Round {session.roundNumber}/{session.maxRounds}</span>
                {session.distanceSignal && (
                  <span style={{ color: session.distanceSignal === 'crossed' ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                    {DISTANCE_LABELS[session.distanceSignal] ?? session.distanceSignal}
                  </span>
                )}
                <span>⏱ {deadlineCountdown(session.deadline)}</span>
              </div>
            </div>

            {isExpanded && (
              <div
                style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px' }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="region"
                aria-label="Session details"
              >
                {session.rounds.length > 0 && (
                  <div style={{ marginBottom: '16px' }}>
                    <h4 style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>ROUND HISTORY</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {session.rounds.map((round) => (
                        <div
                          key={round.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '8px 12px',
                            background: 'rgba(255,255,255,0.02)',
                            borderRadius: '8px',
                            border: '1px solid rgba(255,255,255,0.04)',
                            fontSize: '0.75rem',
                          }}
                        >
                          <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', minWidth: '24px' }}>
                            #{round.roundNumber}
                          </span>
                          <span style={{ color: 'var(--color-text-primary)', fontWeight: 500, minWidth: '36px' }}>
                            {round.actorSide.toUpperCase()}
                          </span>
                          <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                            {round.moveType}
                          </span>
                          {round.opaqueSignal && (
                            <span style={{ color: '#d6a94c', marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>
                              {round.opaqueSignal}
                            </span>
                          )}
                          {round.reasoning && (
                            <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {round.reasoning}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {session.disclosedClaims.length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>DISCLOSURES</h4>
                    <DisclosureTimeline disclosures={session.disclosedClaims} />
                  </div>
                )}

                {session.tradeRef && (
                  <p style={{ margin: '12px 0 0', fontSize: '0.75rem', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>
                    Trade ref: {session.tradeRef}
                  </p>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
