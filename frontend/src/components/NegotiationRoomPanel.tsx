import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Link01Icon,
  LockIcon,
  Shield01Icon,
  Clock01Icon,
} from 'hugeicons-react';
import { apiClient, type NegotiationSession } from '../services/api-client';
import { telemetryClient } from '../services/telemetry-client';
import type { TelemetryEvent } from '../services/telemetry-client';
import { Skeleton } from './Skeleton';

const STATUS_COLORS: Record<NegotiationSession['status'], string> = {
  pairing: '#d6a94c',
  active: 'var(--color-accent)',
  awaiting_approval: '#d6a94c',
  converged: '#4ecdc4',
  settling: '#d6a94c',
  settled: 'var(--color-accent)',
  walked_away: '#e05c5c',
  expired: '#888',
};

const STATUS_LABELS: Record<NegotiationSession['status'], string> = {
  pairing: 'Pairing',
  active: 'Active',
  awaiting_approval: 'Awaiting Approval',
  converged: 'Converged',
  settling: 'Settling',
  settled: 'Settled',
  walked_away: 'Walked Away',
  expired: 'Expired',
};

const ESCALATION_LABELS: Record<NegotiationSession['escalationStatus'], string> = {
  none: 'No escalation',
  pending: 'Escalation pending',
  approved: 'Escalation approved',
  declined: 'Escalation declined',
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
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
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

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

  // Ref to track the latest fetchSessions callback so the telemetry
  // subscription (which binds once on mount) always calls the most
  // recent version without re-subscribing every render.
  const fetchRef = useRef(fetchSessions);
  fetchRef.current = fetchSessions;

  // Debounce timer: batch rapid telemetry events (e.g. multiple
  // negotiation_move_submitted from both sides) into a single
  // REST fetch. 300ms is short enough to feel instant while
  // avoiding a burst of API calls.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Negotiation telemetry phases that signal a session state change
  // worth fetching. All `negotiation_*` phases emitted by the
  // backend during a negotiation lifecycle are included.
  const negotiationPhases = new Set([
    'negotiation_ticket_sealed',
    'negotiation_paired',
    'negotiation_round_open',
    'negotiation_move_submitted',
    'negotiation_disclosure_verified',
    'negotiation_converged',
    'negotiation_walked_away',
    'negotiation_expired',
    'negotiation_settling',
    'negotiation_settled',
  ]);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchSessions();
    });

    // REST polling fallback (5s) — ensures eventual consistency
    // even if the WebSocket drops or misses an event.
    const interval = setInterval(() => {
      void fetchRef.current();
    }, 5000);

    // Fast path: trigger an immediate REST refresh whenever a
    // negotiation-related telemetry event arrives via WebSocket.
    // The 5s poll still runs as a fallback.
    const unsubscribe = telemetryClient.onMessage((event: TelemetryEvent) => {
      if (event.type === 'telemetry.processing.changed' &&
          event.phase &&
          negotiationPhases.has(event.phase as string)) {
        // Debounce: reset the timer on each matching event
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(() => {
          void fetchRef.current();
        }, 300);
      }
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [fetchSessions]);

  const handleApprove = useCallback(
    async (sessionId: string) => {
      setResolvingId(sessionId);
      setActionMessage(null);
      try {
        const result = await apiClient.approveNegotiationEscalation(sessionId);
        setActionMessage(
          result.status === 'settled'
            ? 'Escalation approved. The session settled on the authorized terms.'
            : result.status === 'active'
              ? 'Escalation approved. The session returned to active negotiation.'
              : `Escalation approved (${result.status}).`,
        );
        await fetchSessions();
      } catch (err) {
        setActionMessage(
          err instanceof Error
            ? `Approval failed: ${err.message}`
            : 'Approval failed.',
        );
      } finally {
        setResolvingId(null);
      }
    },
    [fetchSessions],
  );

  const handleDecline = useCallback(
    async (sessionId: string) => {
      setResolvingId(sessionId);
      setActionMessage(null);
      try {
        await apiClient.declineNegotiationEscalation(
          sessionId,
          'Operator declined escalation in the observatory.',
        );
        setActionMessage('Escalation declined. The session has expired.');
        await fetchSessions();
      } catch (err) {
        setActionMessage(
          err instanceof Error
            ? `Decline failed: ${err.message}`
            : 'Decline failed.',
        );
      } finally {
        setResolvingId(null);
      }
    },
    [fetchSessions],
  );

  if (loading && sessions.length === 0) {
    return (
      <div aria-label="Loading negotiation sessions" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Skeleton variant="title" width={180} height={18} style={{ marginBottom: 'var(--spacing-xs)' }} />
        {[1, 2].map((i) => (
          <div key={i} className="card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '40%' }}>
                <Skeleton variant="rect" width={60} height={20} style={{ borderRadius: '4px' }} />
                <Skeleton variant="text" width={80} height={14} style={{ marginBottom: 0 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', width: '40%', justifyContent: 'flex-end' }}>
                <Skeleton variant="text" width={60} height={12} style={{ marginBottom: 0 }} />
                <Skeleton variant="text" width={50} height={12} style={{ marginBottom: 0 }} />
                <Skeleton variant="text" width={80} height={12} style={{ marginBottom: 0 }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Skeleton variant="rect" width={140} height={20} style={{ borderRadius: '4px' }} />
              <Skeleton variant="rect" width={110} height={20} style={{ borderRadius: '4px' }} />
            </div>
          </div>
        ))}
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

      {actionMessage && (
        <div
          role="status"
          className="status-badge secure"
          style={{
            justifyContent: 'center',
            padding: 'var(--spacing-sm)',
            gap: '8px',
          }}
        >
          <CheckmarkCircle01Icon size={14} /> {actionMessage}
        </div>
      )}

      {sessions.map((session) => {
        const isExpanded = expandedId === session.id;
        const trust = TRUST_LABELS[session.trustLevel];
        const pendingProofs = session.disclosureProgress.pendingRequiredClaims.length;
        const verifiedDisclosureCount = session.disclosureProgress.receivedVerifiedClaims.length;
        const statusLabel = STATUS_LABELS[session.status];
        const showEscalationControls =
          session.status === 'awaiting_approval' && session.escalationPending;
        const sessionHandle = `session_${session.id.slice(0, 8)}`;
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
            aria-label={`Negotiation ${sessionHandle} — ${session.status}`}
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
                  {statusLabel}
                </span>
                <span style={{ color: 'var(--color-text-primary)', fontSize: '0.85rem', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                  {sessionHandle}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                <span>Round {session.roundNumber}/{session.maxRounds}</span>
                {session.distanceSignal && (
                  <span style={{ color: session.distanceSignal === 'crossed' ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                    {DISTANCE_LABELS[session.distanceSignal] ?? session.distanceSignal}
                  </span>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Clock01Icon size={12} /> {deadlineCountdown(session.deadline)}
                </span>
              </div>
            </div>

            {/* Aggregate session metadata only — no per-round strategy, no counterparty side, no reasoning, no claim contents */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: `1px solid ${trust.color}40`, background: `${trust.color}10`, color: trust.color, fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                <Link01Icon size={11} /> {trust.label}
              </span>
              {(session.escalationStatus !== 'none' || session.escalationPending) && (
                <span
                  title={session.escalationReason ?? undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: `1px solid ${STATUS_COLORS[session.status]}40`,
                    background: `${STATUS_COLORS[session.status]}10`,
                    color: STATUS_COLORS[session.status],
                    fontSize: '0.66rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <AlertCircleIcon size={11} /> {ESCALATION_LABELS[session.escalationStatus]}
                </span>
              )}
              {pendingProofs > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)', color: 'var(--color-text-secondary)', fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                  <LockIcon size={11} /> {pendingProofs} proof{pendingProofs === 1 ? '' : 's'} pending
                </span>
              )}
              {verifiedDisclosureCount > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(94, 210, 156, 0.25)', background: 'rgba(94, 210, 156, 0.08)', color: 'var(--color-accent)', fontSize: '0.66rem', fontFamily: 'var(--font-mono)' }}>
                  <CheckmarkCircle01Icon size={11} /> {verifiedDisclosureCount} verified
                </span>
              )}
            </div>

            {showEscalationControls && (
              <div
                role="region"
                aria-label="Operator escalation controls"
                style={{
                  marginTop: '14px',
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid rgba(214, 169, 76, 0.35)',
                  background: 'rgba(214, 169, 76, 0.05)',
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#d6a94c', fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }}>
                  <Shield01Icon size={14} />
                  <span>
                    Awaiting operator approval
                    {session.escalationReason ? ` — ${truncate(session.escalationReason, 120)}` : ''}
                  </span>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => void handleApprove(session.id)}
                    disabled={resolvingId === session.id}
                    className="btn"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'var(--color-accent)',
                      color: '#070b0a',
                      border: 'none',
                      borderRadius: '9999px',
                      padding: '6px 14px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.72rem',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      cursor: resolvingId === session.id ? 'wait' : 'pointer',
                      opacity: resolvingId === session.id ? 0.6 : 1,
                    }}
                  >
                    <CheckmarkCircle01Icon size={12} /> Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecline(session.id)}
                    disabled={resolvingId === session.id}
                    className="btn"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      color: 'var(--color-text-primary)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '9999px',
                      padding: '6px 14px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.72rem',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      cursor: resolvingId === session.id ? 'wait' : 'pointer',
                      opacity: resolvingId === session.id ? 0.6 : 1,
                    }}
                  >
                    <Cancel01Icon size={12} /> Decline
                  </button>
                </div>
              </div>
            )}

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
                    <h4 style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>ROUND TIMELINE</h4>
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
                          <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', minWidth: '32px' }}>
                            #{round.roundNumber}
                          </span>
                          <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>
                            {new Date(round.createdAt).toLocaleString()}
                          </span>
                          <span style={{ marginLeft: 'auto', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>
                            completed
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {session.disclosedClaims.length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>DISCLOSURES</h4>
                    <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.75rem' }}>
                      <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>{session.disclosedClaims.length}</span>{' '}
                      verified disclosure{session.disclosedClaims.length === 1 ? '' : 's'} on record. Claim contents are held inside the TEE; the operator view shows the aggregate count only.
                    </p>
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
