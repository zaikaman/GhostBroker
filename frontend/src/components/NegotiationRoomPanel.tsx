import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Link01Icon,
  LockIcon,
} from 'hugeicons-react';
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

const TRUST_LABELS: Record<NegotiationSession['trustLevel'], { label: string; color: string }> = {
  none: { label: 'No trust established', color: '#888' },
  partial: { label: 'Partial trust', color: '#d6a94c' },
  established: { label: 'Trust threshold met', color: 'var(--color-accent)' },
};

const STRATEGY_SIGNAL_LABELS: Record<string, string> = {
  open_patiently: 'Opened patiently',
  test_patience: 'Testing patience',
  concede: 'Made a concession',
  hold_for_better_terms: 'Held for better terms',
  build_trust: 'Building trust',
  request_proof: 'Requested proof',
  accelerate_for_deadline: 'Accelerated due to deadline',
  accept: 'Accepted terms',
  walkaway: 'Walked away',
};

function strategyLabel(intent: string | null): string | null {
  if (!intent) return null;
  return STRATEGY_SIGNAL_LABELS[intent] ?? intent.replace(/_/gu, ' ');
}

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
          No active negotiations. Author a mandate and launch a hosted negotiator to begin confidential pairing.
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
        const trust = TRUST_LABELS[session.trustLevel];
        const strategy = strategyLabel(session.latestStrategySignal);
        const pendingProofs = session.disclosureProgress.pendingRequiredClaims.length;
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

            {/* Strategic AI visibility row — opaque labels only, no live terms */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: `1px solid ${trust.color}40`, background: `${trust.color}10`, color: trust.color, fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                <Link01Icon size={11} /> {trust.label}
              </span>
              {strategy && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(94, 210, 156, 0.2)', background: 'rgba(94, 210, 156, 0.06)', color: 'var(--color-accent)', fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                  {strategy}
                </span>
              )}
              {session.escalationPending && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: '1px solid #d6a94c40', background: '#d6a94c10', color: '#d6a94c', fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                  <AlertCircleIcon size={11} /> Escalation requested
                </span>
              )}
              {pendingProofs > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)', color: 'var(--color-text-secondary)', fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                  <LockIcon size={11} /> {pendingProofs} proof{pendingProofs === 1 ? '' : 's'} pending
                </span>
              )}
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
                    <h4 style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>STRATEGIC MOVES</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {session.rounds.map((round) => {
                        const moveStrategy = strategyLabel(round.strategicIntent);
                        return (
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
                            {moveStrategy && (
                              <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>
                                {moveStrategy}
                              </span>
                            )}
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
                        );
                      })}
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
                  <p style={{ margin: '12px 0 0', fontSize: '0.75rem', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <CheckmarkCircle01Icon size={12} /> Settled — receipt available
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
