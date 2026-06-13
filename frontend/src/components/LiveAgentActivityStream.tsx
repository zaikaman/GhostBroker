import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentState, ProcessingIntent } from '../hooks/useConnectionTelemetry';
import { telemetryClient, type TelemetryEvent } from '../services/telemetry-client';
import { AgentLogEntry } from './AgentLogEntry';

export interface LiveAgentActivityStreamProps {
  agents: AgentState[];
  intents: ProcessingIntent[];
  institutionName: string;       // from session.institution.displayName
  institutionDid: string;        // from session.institution.t3TenantDid
}

export interface LogEntry {
  id: string;
  timestamp: string;
  phase: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

const mapPhaseToLogMessage = (phase: string): string => {
  switch (phase) {
    case 'agent_connecting':
    case 'agent_connected':
      return '🔐 Authenticating to T3...';
    case 'agent_verifying':
      return '🔍 Verifying credentials...';
    case 'agent_verified':
      return '✅ Session verified.';
    case 'agent_rejected':
      return '🚫 Admission denied.';
    case 'intent_received':
      return '📥 Mandate received.';
    case 'intent_sealed':
      return '📦 Order payload blinded.';
    case 'encrypted_evaluation':
      return '🧠 Scanning queue...';
    case 'settlement_pending':
      return '💰 Settlement executing...';
    case 'settlement_finalized':
      return '✨ Settlement signed.';
    case 'settlement_failed':
      return '❌ Settlement failed.';
    case 'receipt_available':
      return '📜 Audit receipt issued.';
    default:
      return phase.replace(/_/g, ' ');
  }
};

const formatTimestamp = (isoString: string): string => {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      return new Date().toTimeString().split(' ')[0] || '';
    }
    return d.toTimeString().split(' ')[0] || '';
  } catch {
    return new Date().toTimeString().split(' ')[0] || '';
  }
};

const getCurrentTime = (): string => {
  return new Date().toTimeString().split(' ')[0] || '';
};

export function LiveAgentActivityStream({
  agents,
  intents,
  institutionName,
  institutionDid
}: LiveAgentActivityStreamProps): React.JSX.Element {
  const [leftLogs, setLeftLogs] = useState<LogEntry[]>([]);
  const [rightLogs, setRightLogs] = useState<LogEntry[]>([]);

  // DIDs mapped to each pane
  const [leftAgentDid, setLeftAgentDid] = useState<string | null>(null);
  const [rightAgentDid, setRightAgentDid] = useState<string | null>(null);

  const leftAgentDidRef = useRef<string | null>(null);
  const rightAgentDidRef = useRef<string | null>(null);

  // Refs for tracking processed agent/intent keys to prevent duplicate logs
  const processedKeysRef = useRef<Set<string>>(new Set());

  // Refs for auto-scroll containers
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);

  // Scroll button states
  const [showLeftScrollButton, setShowLeftScrollButton] = useState(false);
  const [showRightScrollButton, setShowRightScrollButton] = useState(false);

  // Truncate agent DIDs for privacy compliance
  const truncateDid = (did: string) => {
    if (!did) return '';
    if (did.length <= 16) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  };

  // Assign agent DIDs to left/right columns
  const getTargetPane = useCallback((agentDid: string): 'left' | 'right' | null => {
    if (!agentDid) return 'left';

    // If it matches our own institution tenant DID, it goes to the left (Buyer/Own pane)
    if (institutionDid && agentDid.toLowerCase() === institutionDid.toLowerCase()) {
      if (!leftAgentDidRef.current) {
        leftAgentDidRef.current = agentDid;
        setLeftAgentDid(agentDid);
      }
      return 'left';
    }

    // Assign to left if it's the first agent seen and left is empty
    if (!leftAgentDidRef.current) {
      leftAgentDidRef.current = agentDid;
      setLeftAgentDid(agentDid);
      return 'left';
    }

    // Match existing left agent
    if (agentDid === leftAgentDidRef.current) {
      return 'left';
    }

    // Assign to right if right is empty
    if (!rightAgentDidRef.current) {
      rightAgentDidRef.current = agentDid;
      setRightAgentDid(agentDid);
      return 'right';
    }

    // Match existing right agent
    if (agentDid === rightAgentDidRef.current) {
      return 'right';
    }

    // Fallback default
    return 'right';
  }, [institutionDid]);

  // Helper to add a log entry to Left/Right
  const addLogEntry = useCallback((
    agentDid: string,
    phase: string,
    timestampStr?: string,
    severity: 'info' | 'warning' | 'error' = 'info'
  ) => {
    const pane = getTargetPane(agentDid);
    if (!pane) return;

    const formattedTime = timestampStr ? formatTimestamp(timestampStr) : getCurrentTime();
    const message = mapPhaseToLogMessage(phase);
    
    const newEntry: LogEntry = {
      id: `${agentDid}-${phase}-${formattedTime}-${Math.random()}`,
      timestamp: formattedTime,
      phase,
      message,
      severity
    };

    if (pane === 'left') {
      setLeftLogs((prev) => {
        // Prevent immediate duplicate message spam for the same phase
        const lastEntry = prev[prev.length - 1];
        if (lastEntry && lastEntry.phase === phase) return prev;
        const updated = [...prev, newEntry];
        return updated.slice(-100);
      });
    } else {
      setRightLogs((prev) => {
        const lastEntry = prev[prev.length - 1];
        if (lastEntry && lastEntry.phase === phase) return prev;
        const updated = [...prev, newEntry];
        return updated.slice(-100);
      });
    }
  }, [getTargetPane]);

  // Derive plausible counterparty names
  const getCounterpartyName = (did: string | null) => {
    if (!did) return 'Counterparty Agent';
    const lowerDid = did.toLowerCase();
    if (lowerDid.includes('goldman') || lowerDid.includes('gs')) {
      return 'Goldman Sachs';
    }
    if (lowerDid.includes('jpmorgan') || lowerDid.includes('jpm')) {
      return 'JPMorgan';
    }
    if (lowerDid.includes('citibank') || lowerDid.includes('citi')) {
      return 'Citibank';
    }
    if (lowerDid.includes('morgan') || lowerDid.includes('ms')) {
      return 'Morgan Stanley';
    }
    return `Counterparty (${did.slice(0, 8)})`;
  };

  // 1. Subscribe to Live WebSocket Telemetry Event Stream
  useEffect(() => {
    const unsubscribe = telemetryClient.onMessage((event: TelemetryEvent) => {
      const agentDid = event.agentId || event.correlationRef || '';
      if (agentDid) {
        addLogEntry(agentDid, event.phase, event.timestamp, event.severity);
      }
    });

    return unsubscribe;
  }, [addLogEntry]);

  // 2. Fallback: Process input props to guarantee logs are shown, e.g. on fresh mount/page load or in unit tests
  useEffect(() => {
    // Process agents list
    agents.forEach((agent) => {
      const key = `agent-${agent.agentDid}-${agent.status}`;
      if (!processedKeysRef.current.has(key)) {
        processedKeysRef.current.add(key);

        if (agent.status === 'verifying') {
          addLogEntry(agent.agentDid, 'agent_connecting', agent.timestamp);
          addLogEntry(agent.agentDid, 'agent_verifying', agent.timestamp);
        } else if (agent.status === 'verified') {
          addLogEntry(agent.agentDid, 'agent_connecting', agent.timestamp);
          addLogEntry(agent.agentDid, 'agent_verifying', agent.timestamp);
          addLogEntry(agent.agentDid, 'agent_verified', agent.timestamp);
        } else if (agent.status === 'rejected') {
          addLogEntry(agent.agentDid, 'agent_connecting', agent.timestamp);
          addLogEntry(agent.agentDid, 'agent_rejected', agent.timestamp, 'error');
        }
      }
    });
  }, [agents, addLogEntry]);

  useEffect(() => {
    // Process intents list
    intents.forEach((intent) => {
      const key = `intent-${intent.correlationRef}-${intent.phase}`;
      if (!processedKeysRef.current.has(key)) {
        processedKeysRef.current.add(key);
        addLogEntry(intent.agentDid, intent.phase, intent.timestamp);
      }
    });
  }, [intents, addLogEntry]);

  // 3. Scroll control handlers
  const handleScroll = (pane: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const isAtBottom = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop) < 15;
    if (pane === 'left') {
      setShowLeftScrollButton(!isAtBottom);
    } else {
      setShowRightScrollButton(!isAtBottom);
    }
  };

  const scrollToBottom = (pane: 'left' | 'right') => {
    const ref = pane === 'left' ? leftPaneRef : rightPaneRef;
    if (ref.current) {
      ref.current.scrollTo({
        top: ref.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

  // Auto-scroll when logs change and user is currently scrolled to bottom
  useEffect(() => {
    if (!showLeftScrollButton && leftPaneRef.current) {
      leftPaneRef.current.scrollTop = leftPaneRef.current.scrollHeight;
    }
  }, [leftLogs, showLeftScrollButton]);

  useEffect(() => {
    if (!showRightScrollButton && rightPaneRef.current) {
      rightPaneRef.current.scrollTop = rightPaneRef.current.scrollHeight;
    }
  }, [rightLogs, showRightScrollButton]);

  // Determine TEE enclave active state
  const getEnclaveActiveState = () => {
    // 1. Check active intents phases first
    if (intents.length > 0) {
      const latestIntent = intents[intents.length - 1];
      const phase = latestIntent?.phase;
      if (
        phase === 'intent_received' ||
        phase === 'intent_sealed' ||
        phase === 'encrypted_evaluation'
      ) {
        return 'scanning';
      }
      if (phase === 'settlement_pending') {
        return 'executing';
      }
    }

    // 2. Check the most recent log phases
    const allLogs = [...leftLogs, ...rightLogs];
    if (allLogs.length > 0) {
      // Sort by creation ID timestamp suffix or position
      const latestLog = allLogs[allLogs.length - 1];
      const p = latestLog?.phase;
      if (
        p === 'settlement_finalized' ||
        p === 'receipt_available' ||
        p === 'settlement_failed'
      ) {
        return 'purged';
      }
      if (p === 'settlement_pending') {
        return 'executing';
      }
      if (
        p === 'encrypted_evaluation' ||
        p === 'intent_sealed' ||
        p === 'intent_received'
      ) {
        return 'scanning';
      }
      if (p === 'agent_verified' || p === 'agent_verifying') {
        return 'verified';
      }
    }

    // 3. Fallback to agents list states
    const hasVerifying = agents.some((a) => a.status === 'verifying');
    const hasVerified = agents.some((a) => a.status === 'verified');

    if (hasVerifying) return 'scanning';
    if (hasVerified) return 'verified';

    return 'idle';
  };

  const activeState = getEnclaveActiveState();

  // If no agents are connected/connecting, render the enclave placeholder empty state
  const isEnclaveIdle = agents.length === 0 && leftLogs.length === 0 && rightLogs.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <style>{`
        .live-agent-stream-layout {
          display: grid;
          grid-template-columns: 1fr;
          gap: var(--spacing-md);
        }

        @media (min-width: 992px) {
          .live-agent-stream-layout {
            grid-template-columns: 1.2fr 180px 1.2fr;
            gap: var(--spacing-sm);
          }
        }

        .agent-log-panel {
          position: relative;
          background: var(--color-input-bg);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          display: flex;
          flex-direction: column;
          height: 280px;
          overflow: hidden;
          box-shadow: inset 0 0 15px rgba(0, 0, 0, 0.4);
        }

        .agent-log-header {
          background: rgba(22, 29, 47, 0.9);
          border-bottom: 1px solid var(--color-border);
          padding: var(--spacing-sm) var(--spacing-md);
          display: flex;
          flex-direction: column;
          gap: 2px;
          z-index: 5;
        }

        .agent-log-title {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: var(--color-text-primary);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .agent-log-did {
          font-family: var(--font-mono);
          font-size: 0.65rem;
          color: var(--color-text-muted);
        }

        .agent-log-container {
          flex-grow: 1;
          overflow-y: auto;
          padding: var(--spacing-xs);
          display: flex;
          flex-direction: column;
        }

        /* Scroll-to-bottom button */
        .scroll-to-bottom-btn {
          position: absolute;
          bottom: var(--spacing-sm);
          right: var(--spacing-md);
          background: var(--color-accent);
          color: var(--color-bg);
          border: none;
          border-radius: var(--radius-sm);
          padding: 4px 8px;
          font-size: 0.65rem;
          font-family: var(--font-mono);
          font-weight: bold;
          cursor: pointer;
          z-index: 10;
          box-shadow: var(--shadow-md);
          opacity: 0.85;
          transition: all var(--transition-fast);
        }

        .scroll-to-bottom-btn:hover {
          opacity: 1;
          background: var(--color-accent-hover);
          transform: translateY(-1px);
        }

        /* Center Enclave column */
        .enclave-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: rgba(15, 21, 36, 0.5);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--spacing-md) var(--spacing-sm);
          position: relative;
          min-height: 280px;
          box-sizing: border-box;
        }

        .enclave-header {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          color: var(--color-accent);
          letter-spacing: 0.08em;
          margin-bottom: var(--spacing-md);
          text-transform: uppercase;
          text-align: center;
          font-weight: bold;
        }

        /* Timeline Layout */
        .enclave-timeline {
          display: flex;
          flex-direction: column;
          gap: 14px;
          position: relative;
          width: 100%;
        }

        .enclave-timeline::before {
          content: '';
          position: absolute;
          left: 19px;
          top: 6px;
          bottom: 6px;
          width: 2px;
          background: var(--color-border);
          z-index: 1;
        }

        .enclave-step {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          position: relative;
          z-index: 2;
          opacity: 0.35;
          transition: opacity var(--transition-normal);
        }

        .enclave-step.active {
          opacity: 1;
        }

        .enclave-step-node {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--color-border);
          border: 2px solid #0f1524;
          z-index: 2;
          flex-shrink: 0;
          margin-left: 15px;
          transition: all var(--transition-normal);
        }

        .enclave-step.active .enclave-step-node {
          background: var(--color-accent);
          box-shadow: 0 0 8px var(--color-accent);
        }

        .enclave-step.active.scanning .enclave-step-node {
          background: var(--color-warning);
          box-shadow: 0 0 8px var(--color-warning);
          animation: pulse-glow-warning 1.5s infinite;
        }

        .enclave-step.active.verified .enclave-step-node {
          background: var(--color-success);
          box-shadow: 0 0 8px var(--color-success);
        }

        .enclave-step.active.executing .enclave-step-node {
          background: var(--color-accent);
          box-shadow: 0 0 8px var(--color-accent);
          animation: pulse-glow-accent 1.5s infinite;
        }

        .enclave-step.active.purged .enclave-step-node {
          background: var(--color-text-secondary);
          box-shadow: 0 0 8px var(--color-text-secondary);
        }

        .enclave-step-label {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          color: var(--color-text-secondary);
          white-space: nowrap;
        }

        .enclave-step.active .enclave-step-label {
          color: var(--color-text-primary);
          font-weight: bold;
        }

        @keyframes pulse-glow-warning {
          0% { box-shadow: 0 0 0 0px rgba(245, 158, 11, 0.4); }
          70% { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0); }
          100% { box-shadow: 0 0 0 0px rgba(245, 158, 11, 0); }
        }

        @keyframes pulse-glow-accent {
          0% { box-shadow: 0 0 0 0px rgba(var(--color-accent-rgb), 0.4); }
          70% { box-shadow: 0 0 0 5px rgba(var(--color-accent-rgb), 0); }
          100% { box-shadow: 0 0 0 0px rgba(var(--color-accent-rgb), 0); }
        }

        /* Empty state design */
        .stream-empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: var(--spacing-xl);
          border: 1px dashed var(--color-border);
          border-radius: var(--radius-md);
          background: rgba(15, 21, 36, 0.3);
          box-sizing: border-box;
        }

        .empty-icon {
          font-size: 2rem;
          opacity: 0.75;
          margin-bottom: var(--spacing-sm);
        }

        .empty-title {
          color: var(--color-text-primary);
          font-family: var(--font-mono);
          font-size: 0.95rem;
          margin-bottom: var(--spacing-xs);
        }

        .empty-text {
          color: var(--color-text-muted);
          font-size: 0.8rem;
          max-width: 420px;
        }

        .pane-pending-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          flex-grow: 1;
          color: var(--color-text-muted);
          font-family: var(--font-mono);
          font-size: 0.75rem;
          gap: var(--spacing-sm);
          padding: var(--spacing-md);
          text-align: center;
        }

        .mini-radar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 1px dashed rgba(var(--color-accent-rgb), 0.2);
          position: relative;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .mini-radar-sweep {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: conic-gradient(from 0deg at 50% 50%, rgba(var(--color-accent-rgb), 0.15) 0deg, rgba(var(--color-accent-rgb), 0) 90deg);
          animation: radar-sweep-animation 3s linear infinite;
        }

        @keyframes radar-sweep-animation {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>🤖</span> Live Agent Activity Stream
      </h3>

      {isEnclaveIdle ? (
        <div className="stream-empty-state">
          <span className="empty-icon">🛡️</span>
          <h4 className="empty-title">Awaiting agent connections...</h4>
          <p className="empty-text">The enclave is ready. Agents will appear here once they authenticate.</p>
        </div>
      ) : (
        <div className="live-agent-stream-layout">
          {/* LEFT PANEL: Buyer Agent (Own) */}
          <div className="agent-log-panel" tabIndex={0}>
            <div className="agent-log-header">
              <div className="agent-log-title">
                <span>🟢</span> BUYER AGENT LOGS ({institutionName})
              </div>
              <div className="agent-log-did">
                DID: {leftAgentDid ? truncateDid(leftAgentDid) : 'did:t3:verifying...'}
              </div>
            </div>

            <div 
              className="agent-log-container"
              ref={leftPaneRef}
              onScroll={handleScroll('left')}
            >
              {leftLogs.length === 0 ? (
                <div className="pane-pending-state">
                  <div className="mini-radar">
                    <div className="mini-radar-sweep"></div>
                  </div>
                  <div>Awaiting Buyer Agent connection...</div>
                </div>
              ) : (
                leftLogs.map((log) => (
                  <AgentLogEntry
                    key={log.id}
                    timestamp={log.timestamp}
                    phase={log.phase}
                    message={log.message}
                    severity={log.severity}
                  />
                ))
              )}
            </div>

            {showLeftScrollButton && (
              <button className="scroll-to-bottom-btn" onClick={() => scrollToBottom('left')}>
                ▼ Scroll to Bottom
              </button>
            )}
          </div>

          {/* CENTER PANEL: Enclave Visualizer */}
          <div className="enclave-col" tabIndex={0}>
            <div className="enclave-header">GhostBroker TEE</div>
            
            <div className="mini-radar" style={{ width: '48px', height: '48px', marginBottom: '14px' }}>
              <div className="mini-radar-sweep"></div>
              <span style={{ fontSize: '0.9rem', zIndex: 1 }}>🔒</span>
            </div>

            <div className="enclave-timeline">
              <div className={`enclave-step scanning ${activeState === 'scanning' ? 'active' : ''}`}>
                <div className="enclave-step-node"></div>
                <span className="enclave-step-label">🔍 Scanning...</span>
              </div>
              
              <div className={`enclave-step verified ${activeState === 'verified' ? 'active' : ''}`}>
                <div className="enclave-step-node"></div>
                <span className="enclave-step-label">🔑 Session Verified</span>
              </div>
              
              <div className={`enclave-step executing ${activeState === 'executing' ? 'active' : ''}`}>
                <div className="enclave-step-node"></div>
                <span className="enclave-step-label">⚡ Match Execution</span>
              </div>
              
              <div className={`enclave-step purged ${activeState === 'purged' ? 'active' : ''}`}>
                <div className="enclave-step-node"></div>
                <span className="enclave-step-label">🧹 Memory Purged</span>
              </div>
            </div>
          </div>

          {/* RIGHT PANEL: Seller Agent (Counterparty) */}
          <div className="agent-log-panel" tabIndex={0}>
            <div className="agent-log-header">
              <div className="agent-log-title">
                <span>🟡</span> SELLER AGENT LOGS ({getCounterpartyName(rightAgentDid)})
              </div>
              <div className="agent-log-did">
                DID: {rightAgentDid ? truncateDid(rightAgentDid) : 'did:t3:pending...'}
              </div>
            </div>

            <div 
              className="agent-log-container"
              ref={rightPaneRef}
              onScroll={handleScroll('right')}
            >
              {rightLogs.length === 0 ? (
                <div className="pane-pending-state">
                  <div className="mini-radar">
                    <div className="mini-radar-sweep"></div>
                  </div>
                  <div>Awaiting Seller Agent connection...</div>
                </div>
              ) : (
                rightLogs.map((log) => (
                  <AgentLogEntry
                    key={log.id}
                    timestamp={log.timestamp}
                    phase={log.phase}
                    message={log.message}
                    severity={log.severity}
                  />
                ))
              )}
            </div>

            {showRightScrollButton && (
              <button className="scroll-to-bottom-btn" onClick={() => scrollToBottom('right')}>
                ▼ Scroll to Bottom
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LiveAgentActivityStream;
