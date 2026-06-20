import { useState, useEffect, useCallback } from 'react';
import { telemetryClient } from '../services/telemetry-client';
import type { TelemetryEvent, ConnectionStatus, TelemetryPhase } from '../services/telemetry-client';

export interface AgentState {
  agentDid: string;
  status: 'verifying' | 'verified' | 'rejected' | 'revoked';
  connected: boolean;
  authorityRef?: string | undefined;
  timestamp: string;
}

export interface ProcessingIntent {
  correlationRef: string;
  agentDid: string;
  phase: TelemetryPhase;
  timestamp: string;
}

export interface ConnectionTelemetry {
  connectionStatus: ConnectionStatus;
  enclaveStatus: 'secure' | 'processing' | 'error';
  sandboxStatus: 'connected' | 'disconnected';
  agents: AgentState[];
  intents: ProcessingIntent[];
  errorAlert: string | null;
}

export function useConnectionTelemetry(token?: string): ConnectionTelemetry & { clearTelemetryState: () => void } {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [enclaveStatus, setEnclaveStatus] = useState<'secure' | 'processing' | 'error'>('secure');
  const [sandboxStatus, setSandboxStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [intents, setIntents] = useState<ProcessingIntent[]>([]);
  const [errorAlert, setErrorAlert] = useState<string | null>(null);

  // Expose a clear function so callers (e.g. the deploy page's STOP
  // handler) can reset the telemetry view back to its idle defaults
  // without tearing down the WebSocket connection.
  const clearTelemetryState = useCallback(() => {
    setAgents([]);
    setIntents([]);
    setEnclaveStatus('secure');
    setSandboxStatus('disconnected');
    setErrorAlert(null);
  }, []);

  useEffect(() => {
    // Update local connection status when telemetryClient status changes
    const unsubscribeStatus = telemetryClient.onStatusChange((status) => {
      setConnectionStatus(status);
    });

    // Process incoming telemetry events
    const unsubscribeMessages = telemetryClient.onMessage((event: TelemetryEvent) => {
      console.log('[Telemetry WS Message Received]:', event);
      const { type, phase, correlationRef, agentId, severity } = event;
      const parsedAgentDid = agentId || correlationRef || '';

      // Update Enclave Status based on severity and specific error phases
      if (severity === 'error' || phase === 'authorization_failed' || phase === 'service_unavailable') {
        setEnclaveStatus('error');
        if (phase === 'authorization_failed') {
          setErrorAlert('Security alert: TEE Enclave rejected connection authorization.');
        } else {
          setErrorAlert(`System error: ${phase.replace('_', ' ')}`);
        }
      } else if (
        phase === 'intent_received' ||
        phase === 'intent_sealed' ||
        phase === 'encrypted_evaluation' ||
        phase === 'settlement_pending' ||
        (phase.startsWith('negotiation_') &&
          phase !== 'negotiation_walked_away' &&
          phase !== 'negotiation_expired' &&
          phase !== 'negotiation_settled')
      ) {
        setEnclaveStatus('processing');
      } else {
        setEnclaveStatus('secure');
      }

      // 1. Connection Changed Events
      if (type === 'telemetry.connection.changed') {
        if (phase === 't3_sandbox_connected') {
          setSandboxStatus('connected');
        } else if (phase === 'agent_connected' && parsedAgentDid) {
          setAgents((prev) => {
            const exists = prev.some((a) => a.agentDid === parsedAgentDid);
            if (exists) {
              return prev.map((a) =>
                a.agentDid === parsedAgentDid ? { ...a, connected: true, timestamp: event.timestamp } : a
              );
            } else {
              return [
                ...prev,
                {
                  agentDid: parsedAgentDid,
                  status: 'verifying',
                  connected: true,
                  timestamp: event.timestamp,
                },
              ];
            }
          });
        } else if (phase === 'agent_disconnected' && parsedAgentDid) {
          setAgents((prev) =>
            prev.map((a) =>
              a.agentDid === parsedAgentDid ? { ...a, connected: false, timestamp: event.timestamp } : a
            )
          );
        }
      }

      // 2. Agent Status Changed Events
      if (type === 'telemetry.agent.changed' && parsedAgentDid) {
        setAgents((prev) => {
          const exists = prev.some((a) => a.agentDid === parsedAgentDid);
          const newStatus: AgentState['status'] =
            phase === 'agent_verified'
              ? 'verified'
              : phase === 'agent_rejected'
              ? 'rejected'
              : phase === 'authority_revoked'
              ? 'revoked'
              : 'verifying';

          const authorityRef = phase === 'agent_verified' ? correlationRef : undefined;

          if (exists) {
            return prev.map((a) =>
              a.agentDid === parsedAgentDid
                ? {
                    ...a,
                    status: newStatus,
                    authorityRef: authorityRef || a.authorityRef,
                    timestamp: event.timestamp,
                  }
                : a
            );
          } else {
            return [
              ...prev,
              {
                agentDid: parsedAgentDid,
                status: newStatus,
                connected: true, // Default to true if receiving telemetry for it
                authorityRef,
                timestamp: event.timestamp,
              },
            ];
          }
        });
      }

      // 3. Processing Events
      if (type === 'telemetry.processing.changed') {
        const intentRef = correlationRef || '';
        if (intentRef) {
          setIntents((prev) => {
            // Remove from active rail if the intent completes or fails
            if (
              phase === 'settlement_finalized' ||
              phase === 'settlement_failed' ||
              phase === 'receipt_available'
            ) {
              return prev.filter((i) => i.correlationRef !== intentRef);
            }

            const exists = prev.some((i) => i.correlationRef === intentRef);
            if (exists) {
              return prev.map((i) =>
                i.correlationRef === intentRef
                  ? { ...i, phase, timestamp: event.timestamp, agentDid: agentId || i.agentDid }
                  : i
              );
            } else {
              return [
                ...prev,
                {
                  correlationRef: intentRef,
                  agentDid: agentId || '',
                  phase,
                  timestamp: event.timestamp,
                },
              ];
            }
          });
        }
      }
    });

    // Initiate connection to the telemetry server
    telemetryClient.connect(token);

    // Clean up connections and listeners on unmount
    return () => {
      unsubscribeStatus();
      unsubscribeMessages();
      telemetryClient.disconnect();
    };
  }, [token]);

  return {
    connectionStatus,
    enclaveStatus,
    sandboxStatus,
    agents,
    intents,
    errorAlert,
    clearTelemetryState,
  };
}
export default useConnectionTelemetry;
