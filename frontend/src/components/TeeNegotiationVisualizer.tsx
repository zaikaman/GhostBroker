import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { AgentState, ProcessingIntent } from '../hooks/useConnectionTelemetry';
import {
  Shield01Icon,
  Robot01Icon,
  CpuIcon,
  LockIcon
} from 'hugeicons-react';

export interface TeeNegotiationVisualizerProps {
  agents: AgentState[];
  intents: ProcessingIntent[];
  institutionName: string;
  institutionDid: string;
  compact?: boolean;
}

interface DialogueMessage {
  id: string;
  sender: string;
  message: string;
  time: string;
  isSystem: boolean;
}

export function TeeNegotiationVisualizer({
  agents,
  intents,
  institutionName,
  institutionDid,
  compact = false
}: TeeNegotiationVisualizerProps): React.JSX.Element {
  console.log('[DEBUG TeeNegotiationVisualizer]: rendering with props', { agents, intents, institutionName, institutionDid, compact });
  const [messages, setMessages] = useState<DialogueMessage[]>([]);
  const processedPhasesRef = useRef<Set<string>>(new Set());

  // Truncate agent DIDs for privacy compliance
  const truncateDid = (did: string) => {
    if (!did) return '';
    if (did.length <= 16) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  };

  // Find the local agent and the counterparty agent if they exist
  const localAgent = useMemo(() => {
    const found = agents.find(a => a.agentDid.toLowerCase() === institutionDid.toLowerCase()) || agents[0];
    if (found) return found;
    if (intents.length > 0) {
      const intentWithDid = intents.find(i => i.agentDid);
      if (intentWithDid) {
        return {
          agentDid: intentWithDid.agentDid,
          status: 'verified' as const,
          connected: true,
          timestamp: intentWithDid.timestamp
        };
      }
    }
    return null;
  }, [agents, institutionDid, intents]);

  const counterpartyAgent = useMemo(() => {
    if (agents.length > 1) {
      return agents.find(a => a.agentDid.toLowerCase() !== institutionDid.toLowerCase()) || agents[1] || null;
    }
    return null;
  }, [agents, institutionDid]);

  // Determine counterparty display name
  const getCounterpartyName = (did: string | null) => {
    if (!did) return 'Counterparty';
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

  // Determine current matching pipeline stage (1 to 6)
  const activeStage = useMemo(() => {
    if (intents.length === 0) {
      if (localAgent?.status === 'verifying') return 1;
      if (localAgent?.status === 'verified') return 1;
      return 0; // idle
    }
    const latestIntent = intents[intents.length - 1];
    const phase = latestIntent?.phase;
    if (!phase) return 0;

    switch (phase) {
      case 'agent_connected':
      case 'agent_verifying':
      case 'agent_verified':
        return 1;
      case 'intent_received':
      case 'intent_sealed':
        return 2;
      case 'negotiation_ticket_sealed':
        return 3;
      case 'negotiation_paired':
      case 'negotiation_round_open':
      case 'negotiation_move_submitted':
      case 'negotiation_disclosure_verified':
        return 4;
      case 'negotiation_converged':
      case 'negotiation_settling':
      case 'settlement_pending':
        return 5;
      case 'negotiation_settled':
      case 'settlement_finalized':
      case 'receipt_available':
        return 6;
      default:
        return 4;
    }
  }, [localAgent, intents]);

  const latestPhase = useMemo(() => {
    if (intents.length > 0) {
      return intents[intents.length - 1]?.phase;
    }
    if (localAgent) {
      return localAgent.status === 'verified' ? 'agent_verified' : 'agent_verifying';
    }
    return null;
  }, [localAgent, intents]);

  // Generate simulated dialogue logs inside TEE to explain the processing events
  useEffect(() => {
    if (!latestPhase) {
      setMessages([]);
      processedPhasesRef.current.clear();
      return;
    }

    const key = `${latestPhase}-${intents.length}`;
    if (processedPhasesRef.current.has(key)) return;
    processedPhasesRef.current.add(key);

    const time = new Date().toTimeString().split(' ')[0] || '';
    const localName = institutionName || 'Local Agent';
    const peerName = getCounterpartyName(counterpartyAgent?.agentDid ?? null);

    let newMessages: Omit<DialogueMessage, 'id'>[] = [];

    switch (latestPhase) {
      case 'agent_verifying':
        newMessages = [
          { sender: 'System Enclave', message: 'Verifying authority DID credentials against decentralized registrar...', time, isSystem: true },
          { sender: localName, message: 'Initiating secure handshake sequence.', time, isSystem: false }
        ];
        break;
      case 'agent_verified':
        newMessages = [
          { sender: 'System Enclave', message: 'Attestation verified. Cryptographic execution admitted.', time, isSystem: true },
          { sender: localName, message: 'Attestation key registered. Entering dormant queue.', time, isSystem: false }
        ];
        break;
      case 'intent_received':
      case 'intent_sealed':
        newMessages = [
          { sender: 'System Enclave', message: 'Blinded mandate envelope received. Obscuring variables.', time, isSystem: true },
          { sender: localName, message: 'Mandate sealed inside secure register bounds.', time, isSystem: false }
        ];
        break;
      case 'negotiation_ticket_sealed':
        newMessages = [
          { sender: 'System Enclave', message: 'Matching ticket generated and sealed. Awaiting peer entry.', time, isSystem: true },
          { sender: localName, message: 'Standing order registered under privacy protection.', time, isSystem: false }
        ];
        break;
      case 'negotiation_paired':
        newMessages = [
          { sender: 'System Enclave', message: 'Compatible counterparty matched. Initializing confidential negotiation.', time, isSystem: true },
          { sender: localName, message: 'Channel established. Ready for iterative evaluation.', time, isSystem: false },
          { sender: peerName, message: 'Channel established. Bounded limits synced.', time, isSystem: false }
        ];
        break;
      case 'negotiation_round_open':
        newMessages = [
          { sender: 'System Enclave', message: `Negotiation round open. Evaluating next move.`, time, isSystem: true },
          { sender: localName, message: 'Computing valuation relative to market anchor...', time, isSystem: false },
          { sender: peerName, message: 'Computing utility bound boundaries...', time, isSystem: false }
        ];
        break;
      case 'negotiation_move_submitted':
        newMessages = [
          { sender: 'System Enclave', message: 'Move received. Validating compliance checks.', time, isSystem: true },
          { sender: localName, message: 'Offer updated. Checking strategy overlap.', time, isSystem: false }
        ];
        break;
      case 'negotiation_disclosure_verified':
        newMessages = [
          { sender: 'System Enclave', message: 'Selective disclosures exchanged and verified.', time, isSystem: true },
          { sender: peerName, message: 'Verifiable credentials parsed successfully.', time, isSystem: false }
        ];
        break;
      case 'negotiation_converged':
        newMessages = [
          { sender: 'System Enclave', message: 'Convergence! Trade criteria matched. Locking transaction details.', time, isSystem: true },
          { sender: localName, message: 'Final terms approved. Initiating atomic settlement.', time, isSystem: false },
          { sender: peerName, message: 'Final terms approved. Syncing wallet signatures.', time, isSystem: false }
        ];
        break;
      case 'negotiation_settling':
      case 'settlement_pending':
        newMessages = [
          { sender: 'System Enclave', message: 'Initiating atomic balance swap on external blockchain.', time, isSystem: true },
          { sender: localName, message: 'Deposits locked in escrow. Awaiting confirmation.', time, isSystem: false }
        ];
        break;
      case 'negotiation_settled':
      case 'settlement_finalized':
        newMessages = [
          { sender: 'System Enclave', message: 'Settlement confirmed. Trade finalized on ledger.', time, isSystem: true },
          { sender: localName, message: 'Cleared successfully. Cleaning up workspace.', time, isSystem: false },
          { sender: peerName, message: 'Cleared successfully. Cleaning up workspace.', time, isSystem: false }
        ];
        break;
      case 'receipt_available':
        newMessages = [
          { sender: 'System Enclave', message: 'Cryptographic audit receipt generated. Zeroing volatile memory.', time, isSystem: true },
          { sender: 'System Enclave', message: 'Memory purge verified. Enclave state wiped.', time, isSystem: true }
        ];
        break;
      case 'negotiation_walked_away':
        newMessages = [
          { sender: 'System Enclave', message: 'Session closed: strategy boundaries do not overlap.', time, isSystem: true },
          { sender: localName, message: 'Withdrew from match. Strategy limits reached.', time, isSystem: false }
        ];
        break;
      case 'settlement_failed':
        newMessages = [
          { sender: 'System Enclave', message: 'Settlement failed. Reverting deposit states.', time, isSystem: true }
        ];
        break;
      default:
        break;
    }

    if (newMessages.length > 0) {
      setMessages(prev => {
        const withIds = newMessages.map((m, idx) => ({
          ...m,
          id: `${latestPhase}-${Date.now()}-${idx}`
        }));
        // Cap dialogue to last 15 messages for cleaner view
        return [...prev, ...withIds].slice(-15);
      });
    }
  }, [latestPhase, intents.length, localAgent, counterpartyAgent, institutionName]);

  // Clean state when agents are disconnected
  useEffect(() => {
    if (agents.length === 0 && intents.length === 0 && !localAgent) {
      setMessages([]);
      processedPhasesRef.current.clear();
    }
  }, [agents, intents.length, localAgent]);

  const handleClearDialogue = () => {
    setMessages([]);
  };

  const isEnclaveActive = agents.length > 0 || intents.length > 0 || localAgent !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', flex: 1, minHeight: 0 }}>
      <style>{`
        /* Master Scope Visualizer */
        .match-arena-card {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md);
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          box-shadow: var(--shadow-lg), var(--shadow-premium);
          flex: 1;
        }

        .match-arena-title {
          font-family: var(--font-mono);
          font-size: 0.85rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: var(--color-text-primary);
          display: flex;
          align-items: center;
          gap: 8px;
          border-bottom: 1px solid var(--color-border);
          padding-bottom: var(--spacing-sm);
          margin: 0;
        }

        /* Top diagram containing nodes */
        .match-diagram-container {
          position: relative;
          height: 180px;
          border: 1px solid rgba(255, 255, 255, 0.03);
          border-radius: var(--radius-md);
          background: radial-gradient(circle at 50% 50%, rgba(15, 22, 38, 0.6) 0%, rgba(8, 12, 21, 0.9) 100%);
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 var(--spacing-xl);
        }

        .compact-diagram {
          height: 140px;
        }

        /* Connecting Wires/Paths */
        .diagram-wires {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 1;
        }

        .wire-path {
          stroke: rgba(255, 255, 255, 0.05);
          stroke-width: 1.5;
          fill: none;
        }

        .wire-path.active {
          stroke: rgba(94, 210, 156, 0.2);
          stroke-dasharray: 6 6;
          animation: flow-dash 15s linear infinite;
        }

        @keyframes flow-dash {
          to {
            stroke-dashoffset: -360;
          }
        }

        /* Animated signal pulses */
        .signal-pulse {
          fill: var(--color-accent);
          filter: drop-shadow(0 0 4px var(--color-accent));
        }

        .signal-pulse-counter {
          fill: var(--color-warning);
          filter: drop-shadow(0 0 4px var(--color-warning));
        }

        /* Agent Nodes */
        .agent-node {
          position: relative;
          z-index: 2;
          width: 68px;
          height: 68px;
          border-radius: 50%;
          background: rgba(15, 22, 38, 0.85);
          border: 2px solid var(--color-border);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all var(--transition-normal);
          cursor: pointer;
        }

        .agent-node.local.active {
          border-color: var(--color-accent);
          box-shadow: 0 0 15px rgba(94, 210, 156, 0.3);
        }

        .agent-node.peer.active {
          border-color: var(--color-warning);
          box-shadow: 0 0 15px rgba(245, 158, 11, 0.3);
        }

        .agent-node-icon {
          font-size: 1.5rem;
          color: var(--color-text-secondary);
        }

        .agent-node.active .agent-node-icon {
          color: var(--color-text-primary);
        }

        .agent-node-label {
          position: absolute;
          bottom: -28px;
          left: 50%;
          transform: translateX(-50%);
          white-space: nowrap;
          font-family: var(--font-mono);
          font-size: 0.65rem;
          color: var(--color-text-secondary);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }

        .agent-node.active .agent-node-label {
          color: var(--color-text-primary);
        }

        /* Center Enclave Hub */
        .enclave-hub-core {
          position: relative;
          z-index: 2;
          width: 90px;
          height: 90px;
          border-radius: 50%;
          background: rgba(10, 15, 28, 0.95);
          border: 1px solid var(--color-border);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all var(--transition-normal);
        }

        .compact-enclave {
          width: 70px;
          height: 70px;
        }

        .enclave-hub-core.active {
          border-color: var(--color-accent);
          box-shadow: 0 0 25px rgba(94, 210, 156, 0.2);
        }

        .enclave-hub-core.processing {
          border-color: var(--color-warning);
          box-shadow: 0 0 25px rgba(245, 158, 11, 0.25);
          animation: pulse-ring-warning 2s infinite;
        }

        @keyframes pulse-ring-warning {
          0% { box-shadow: 0 0 0 0px rgba(245, 158, 11, 0.3); }
          70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
          100% { box-shadow: 0 0 0 0px rgba(245, 158, 11, 0); }
        }

        /* Rotating concentric SVG graphics inside TEE core */
        .enclave-hologram {
          position: absolute;
          width: 130%;
          height: 130%;
          pointer-events: none;
        }

        .enclave-hub-icon {
          color: var(--color-text-muted);
          transition: all var(--transition-normal);
        }

        .enclave-hub-core.active .enclave-hub-icon {
          color: var(--color-accent);
          animation: float-slow 3s ease-in-out infinite;
        }

        .enclave-hub-core.processing .enclave-hub-icon {
          color: var(--color-warning);
        }

        @keyframes float-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        /* Strategy convergence scope (Wow graphics!) */
        .strategy-scope-container {
          display: grid;
          grid-template-columns: 1.2fr 1fr;
          gap: var(--spacing-md);
          min-height: 120px;
        }

        .compact-scope {
          grid-template-columns: 1fr;
        }

        .oscilloscope-box {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: rgba(8, 12, 21, 0.7);
          overflow: hidden;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 120px;
        }

        .oscilloscope-label {
          position: absolute;
          top: 6px;
          left: 10px;
          font-family: var(--font-mono);
          font-size: 0.58rem;
          letter-spacing: 0.05em;
          color: var(--color-text-muted);
          text-transform: uppercase;
        }

        /* 6-Stage Progress Steps */
        .stage-pipeline {
          display: flex;
          justify-content: space-between;
          position: relative;
          margin: var(--spacing-sm) 0;
          padding: 0 var(--spacing-xs);
        }

        .stage-pipeline::before {
          content: '';
          position: absolute;
          left: 10px;
          right: 10px;
          top: 10px;
          height: 2px;
          background: var(--color-border);
          z-index: 1;
        }

        .stage-node-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          position: relative;
          z-index: 2;
          width: 50px;
        }

        .stage-circle {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--color-bg);
          border: 2px solid var(--color-border);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.6rem;
          font-family: var(--font-mono);
          font-weight: 700;
          color: var(--color-text-muted);
          transition: all var(--transition-normal);
        }

        .stage-node-item.active .stage-circle {
          border-color: var(--color-accent);
          background: rgba(94, 210, 156, 0.1);
          color: var(--color-accent);
          box-shadow: 0 0 8px var(--color-accent);
        }

        .stage-node-item.completed .stage-circle {
          border-color: var(--color-success);
          background: var(--color-success);
          color: var(--color-bg);
        }

        .stage-label-text {
          font-family: var(--font-mono);
          font-size: 0.55rem;
          color: var(--color-text-muted);
          text-align: center;
          white-space: nowrap;
        }

        .stage-node-item.active .stage-label-text {
          color: var(--color-text-primary);
          font-weight: bold;
        }

        /* Dialogue Speech boxes */
        .dialogue-stream {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: rgba(2, 6, 12, 0.5);
          height: 120px;
          overflow-y: auto;
          padding: var(--spacing-sm);
          display: flex;
          flex-direction: column;
          gap: 6px;
          box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
        }

        .dialogue-bubble {
          display: flex;
          flex-direction: column;
          gap: 1px;
          font-size: 0.72rem;
          line-height: 1.35;
          padding: 4px 8px;
          border-radius: 4px;
        }

        .dialogue-bubble.system {
          background: rgba(255, 255, 255, 0.02);
          border-left: 2px solid var(--color-accent);
          color: var(--color-text-secondary);
        }

        .dialogue-bubble.agent {
          background: rgba(94, 210, 156, 0.03);
          border-left: 2px solid var(--color-success);
          color: var(--color-text-primary);
        }

        .dialogue-bubble.peer {
          background: rgba(245, 158, 11, 0.03);
          border-left: 2px solid var(--color-warning);
          color: var(--color-text-primary);
        }

        .dialogue-header {
          display: flex;
          justify-content: space-between;
          font-family: var(--font-mono);
          font-size: 0.58rem;
          color: var(--color-text-muted);
        }

        .dialogue-body {
          font-family: var(--font-mono);
          word-break: break-all;
        }

        /* Empty states */
        .visualizer-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: var(--spacing-xl) var(--spacing-md);
          border: 1px dashed var(--color-border);
          border-radius: var(--radius-md);
          background: rgba(10, 15, 28, 0.3);
          flex: 1;
        }

        .empty-glow-icon {
          color: var(--color-text-muted);
          opacity: 0.4;
          margin-bottom: var(--spacing-md);
          animation: float-slow 3s ease-in-out infinite;
        }

        .empty-heading {
          font-family: var(--font-mono);
          font-size: 0.85rem;
          color: var(--color-text-primary);
          margin: 0 0 6px 0;
          text-transform: uppercase;
        }

        .empty-desc {
          font-size: 0.75rem;
          color: var(--color-text-secondary);
          max-width: 380px;
          line-height: 1.45;
          margin: 0;
        }
      `}</style>

      <div className="match-arena-card">
        <h3 className="match-arena-title">
          <CpuIcon size={16} style={{ color: 'var(--color-accent)' }} /> Cryptographic Execution Arena
        </h3>

        {!isEnclaveActive ? (
          <div className="visualizer-empty">
            <Shield01Icon size={42} className="empty-glow-icon" />
            <h4 className="empty-heading">Awaiting agent connections...</h4>
            <p className="empty-desc">
              The enclave is ready. Launch the hosted negotiator agent to open secure channels.
            </p>
          </div>
        ) : (
          <>
            {/* 1. Visual Match Arena Nodes */}
            <div className={`match-diagram-container ${compact ? 'compact-diagram' : ''}`}>
              {/* SVG wires & flowing signals */}
              <svg className="diagram-wires">
                {/* Path 1: Local Agent to TEE */}
                <path className="wire-path active" d="M 120, 90 Q 200, 60 270, 90" id="path-local" />
                <path className="wire-path active" d="M 120, 90 Q 200, 120 270, 90" />
                
                {/* Path 2: Peer Agent to TEE */}
                {counterpartyAgent && (
                  <>
                    <path className="wire-path active" d="M 420, 90 Q 340, 60 270, 90" id="path-peer" />
                    <path className="wire-path active" d="M 420, 90 Q 340, 120 270, 90" />
                  </>
                )}

                {/* Animated Light Pulses */}
                {activeStage > 0 && (
                  <circle r="4" className="signal-pulse">
                    <animateMotion dur="2.5s" repeatCount="indefinite" path="M 120, 90 Q 200, 60 270, 90" />
                  </circle>
                )}
                {activeStage >= 4 && counterpartyAgent && (
                  <circle r="4" className="signal-pulse-counter">
                    <animateMotion dur="3s" repeatCount="indefinite" path="M 420, 90 Q 340, 60 270, 90" />
                  </circle>
                )}
              </svg>

              {/* Node 1: Local Agent */}
              <div 
                className={`agent-node local ${localAgent ? 'active' : ''}`}
                title={`Local DID: ${localAgent?.agentDid || 'None'}`}
              >
                <Robot01Icon className="agent-node-icon" size={24} />
                <div className="agent-node-label">
                  <strong>{institutionName}</strong>
                  <span>{localAgent ? truncateDid(localAgent.agentDid) : 'did:pending'}</span>
                </div>
              </div>

              {/* Node 2: TEE Hub */}
              <div className={`enclave-hub-core ${activeStage >= 5 ? 'active' : activeStage >= 2 ? 'processing' : ''} ${compact ? 'compact-enclave' : ''}`}>
                {/* rotating orbits */}
                <svg className="enclave-hologram" viewBox="0 0 120 120">
                  <circle 
                    cx="60" 
                    cy="60" 
                    r="48" 
                    fill="none" 
                    stroke={activeStage >= 2 ? 'var(--color-accent)' : 'rgba(255, 255, 255, 0.05)'} 
                    strokeWidth="1.5" 
                    strokeDasharray="20 40 10 30" 
                    style={{ 
                      transformOrigin: 'center', 
                      animation: 'spin 12s linear infinite',
                      opacity: activeStage >= 2 ? 0.8 : 0.2
                    }} 
                  />
                  <circle 
                    cx="60" 
                    cy="60" 
                    r="38" 
                    fill="none" 
                    stroke={activeStage >= 4 ? 'var(--color-warning)' : 'rgba(255, 255, 255, 0.03)'} 
                    strokeWidth="1" 
                    strokeDasharray="15 25" 
                    style={{ 
                      transformOrigin: 'center', 
                      animation: 'spin 8s linear infinite reverse',
                      opacity: activeStage >= 4 ? 0.6 : 0.2
                    }} 
                  />
                </svg>
                <LockIcon className="enclave-hub-icon" size={28} />
                <div className="agent-node-label" style={{ bottom: compact ? '-22px' : '-28px' }}>
                  <strong>{activeStage >= 5 ? 'FINALIZING' : activeStage >= 2 ? 'EVALUATING' : 'SECURE'}</strong>
                  <span>GHOSTBROKER TEE</span>
                </div>
              </div>

              {/* Node 3: Counterparty Agent */}
              <div 
                className={`agent-node peer ${counterpartyAgent || activeStage >= 4 ? 'active' : ''}`}
                style={{ opacity: counterpartyAgent || activeStage >= 4 ? 1 : 0.3 }}
                title={`Peer DID: ${counterpartyAgent?.agentDid || 'Hidden Counterparty'}`}
              >
                <Robot01Icon className="agent-node-icon" size={24} />
                <div className="agent-node-label">
                  <strong>{counterpartyAgent ? getCounterpartyName(counterpartyAgent.agentDid) : activeStage >= 4 ? 'Counterparty' : 'Matching Engine'}</strong>
                  <span>{counterpartyAgent ? truncateDid(counterpartyAgent.agentDid) : activeStage >= 4 ? 'did:t3:confidential...' : 'Awaiting Pair...'}</span>
                </div>
              </div>
            </div>

            {/* 2. 6-Stage Progress Steps */}
            <div className="stage-pipeline">
              {[
                { step: 1, label: 'Attest' },
                { step: 2, label: 'Blind' },
                { step: 3, label: 'Pair' },
                { step: 4, label: 'Negotiate' },
                { step: 5, label: 'Settle' },
                { step: 6, label: 'Purge' }
              ].map((item) => {
                const isActive = activeStage === item.step;
                const isCompleted = activeStage > item.step;
                return (
                  <div key={item.step} className={`stage-node-item ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}>
                    <div className="stage-circle">
                      {isCompleted ? '✓' : item.step}
                    </div>
                    <span className="stage-label-text">{item.label}</span>
                  </div>
                );
              })}
            </div>

            {/* 3. Detail Views (Scope & Dialogues) */}
            <div className={`strategy-scope-container ${compact ? 'compact-scope' : ''}`}>
              {/* Strategy convergence oscilloscope */}
              <div className="oscilloscope-box">
                <div className="oscilloscope-label">Confidential Strategy Convergence Scope</div>
                
                {/* Simulated oscilloscope curves */}
                <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
                  <line x1="0" y1="60" x2="100%" y2="60" stroke="rgba(255, 255, 255, 0.05)" strokeDasharray="4 4" />
                  
                  {activeStage >= 4 ? (
                    <>
                      {/* Local Wave */}
                      <path 
                        d={`M 0,60 Q 50,${60 - 20 / activeStage} 100,60 T 200,60 T 300,60 T 400,60`} 
                        fill="none" 
                        stroke="var(--color-accent)" 
                        strokeWidth="1.5" 
                        opacity="0.85"
                      >
                        <animate attributeName="d" 
                          values={
                            activeStage === 4 
                            ? "M 0,60 Q 40,20 80,60 T 160,60 T 240,60 T 320,60" 
                            : activeStage === 5 
                            ? "M 0,60 Q 40,50 80,60 T 160,60 T 240,60 T 320,60"
                            : "M 0,60 Q 40,60 80,60 T 160,60 T 240,60 T 320,60"
                          } 
                          dur="4s" 
                          repeatCount="indefinite" 
                        />
                      </path>

                      {/* Counterparty Wave */}
                      <path 
                        d={`M 0,60 Q 30,${60 + 25 / activeStage} 80,60 T 160,60 T 240,60 T 320,60`} 
                        fill="none" 
                        stroke="var(--color-warning)" 
                        strokeWidth="1.5" 
                        opacity="0.75"
                      >
                        <animate attributeName="d" 
                          values={
                            activeStage === 4 
                            ? "M 0,60 Q 30,100 70,60 T 140,60 T 210,60 T 280,60" 
                            : activeStage === 5 
                            ? "M 0,60 Q 30,70 70,60 T 140,60 T 210,60 T 280,60"
                            : "M 0,60 Q 30,60 70,60 T 140,60 T 210,60 T 280,60"
                          } 
                          dur="3s" 
                          repeatCount="indefinite" 
                        />
                      </path>

                      {/* Glow indicator at center of convergence */}
                      {activeStage >= 5 && (
                        <circle cx="50%" cy="60" r="6" fill="var(--color-success)">
                          <animate attributeName="r" values="4;9;4" dur="1.5s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />
                        </circle>
                      )}
                    </>
                  ) : (
                    // Flat idle wave
                    <path d="M 0,60 L 500,60" fill="none" stroke="rgba(255, 255, 255, 0.15)" strokeWidth="1" />
                  )}
                </svg>
                
                <div style={{ zIndex: 5, fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--color-text-secondary)', background: 'rgba(0, 0, 0, 0.6)', padding: '4px 8px', borderRadius: '4px' }}>
                  {activeStage === 0 && 'Awaiting Active Matching Session'}
                  {activeStage === 1 && 'Authenticating Sessions...'}
                  {activeStage === 2 && 'Sealing Intent Structures...'}
                  {activeStage === 3 && 'Queue Scanning: Awaiting Counterparty pairing'}
                  {activeStage === 4 && 'Confidential Valuation Iterations In Progress'}
                  {activeStage === 5 && 'CONVERGED: Executing Ledger Settlement Swaps'}
                  {activeStage === 6 && 'TRADE FINALIZED: Memory purges completed.'}
                </div>
              </div>

              {/* Dialogue Box showing secure event updates */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>Secure Enclave Dialogue Transcript</span>
                  {messages.length > 0 && (
                    <button 
                      type="button" 
                      onClick={handleClearDialogue}
                      style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.58rem' }}
                    >
                      CLEAR
                    </button>
                  )}
                </div>
                <div className="dialogue-stream">
                  {messages.length === 0 ? (
                    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                      No dialogue logs generated.
                    </div>
                  ) : (
                    messages.map((msg) => {
                      const isSys = msg.isSystem;
                      const isPeer = msg.sender.toLowerCase().includes('counterparty') || msg.sender.toLowerCase().includes('sachs') || msg.sender.toLowerCase().includes('morgan') || msg.sender.toLowerCase().includes('citibank') || msg.sender.toLowerCase().includes('jpmorgan');
                      
                      return (
                        <div key={msg.id} className={`dialogue-bubble ${isSys ? 'system' : isPeer ? 'peer' : 'agent'}`}>
                          <div className="dialogue-header">
                            <span>{msg.sender}</span>
                            <span>{msg.time}</span>
                          </div>
                          <div className="dialogue-body">
                            {msg.message}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default TeeNegotiationVisualizer;
