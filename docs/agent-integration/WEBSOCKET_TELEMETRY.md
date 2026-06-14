# WebSocket Telemetry: Real-Time Agent Events

GhostBroker provides a real-time WebSocket telemetry stream so your agent can monitor its connection status, processing state, and settlement outcomes without polling.

## Connection

Endpoint:
```
wss://ghostbroker-api.example.com/ws/telemetry?institutionId=<your-institution-uuid>
```

Authentication: The institution ID in the query parameter is used to filter events. Only events for your institution are sent to your connection.

```typescript
const ws = new WebSocket(
  `wss://ghostbroker-api.example.com/ws/telemetry?institutionId=${institutionId}`
);
```

## Event Envelope

All events share a common envelope:

```json
{
  "eventId": "evt_01HX...",
  "institutionId": "uuid",
  "type": "telemetry.connection.changed",
  "phase": "agent_connected",
  "severity": "info",
  "timestamp": "2026-06-12T10:00:00.000Z",
  "correlationRef": "opaque_ref",
  "agentId": "did:t3n:0xAgentAddress"
}
```

### Envelope Fields

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | string | Unique event identifier |
| `institutionId` | string (uuid) | Your institution ID |
| `type` | string | Event category (see below) |
| `phase` | string | Specific state within the category |
| `severity` | string | `info`, `warning`, or `error` |
| `timestamp` | string (ISO 8601) | When the event occurred |
| `correlationRef` | string (optional) | Opaque reference linking events (e.g., intent handle) |
| `agentId` | string (optional) | The agent DID this event relates to |
| `receiptRef` | string (optional) | Receipt UUID when a receipt is available |

## Event Types

### `telemetry.connection.changed` — Connectivity Status

| Phase | Severity | Description |
|-------|----------|-------------|
| `backend_connected` | info | GhostBroker API server is online |
| `websocket_connected` | info | Your WebSocket telemetry channel is open |
| `supabase_connected` | info | Data storage layer is operational |
| `t3_sandbox_connected` | info | Terminal 3 sandbox network is reachable |
| `agent_connected` | info | An agent has connected to the enclave |
| `agent_disconnected` | info | An agent session has terminated |

### `telemetry.agent.changed` — Agent Admission Status

| Phase | Severity | Description |
|-------|----------|-------------|
| `agent_verifying` | info | Enclave is validating agent DID and delegation credential |
| `agent_verified` | success | Agent identity and scope verified, admitted to trading |
| `agent_rejected` | error | Agent was rejected (invalid signature or verification failure) |
| `authority_revoked` | error | Delegation grant revoked, session terminated |

### `telemetry.processing.changed` — Trading Intent Lifecycle

| Phase | Severity | Description |
|-------|----------|-------------|
| `intent_received` | info | Encrypted intent envelope received by enclave |
| `intent_sealed` | info | Intent parameters blinded, opaque handle registered |
| `encrypted_evaluation` | info | TEE matching engine is evaluating crossing criteria |
| `settlement_pending` | info | Match found, atomic settlement executing |
| `settlement_finalized` | success | Settlement complete, balances updated |
| `receipt_available` | success | Cryptographic audit receipt issued |
| `intent_cancelled` | warning | Agent cancelled a pending intent before settlement; balance lock released |
| `intent_expired` | warning | Pending intent exceeded TTL and was evicted from the matching queue; balance lock released |
| `intent_lock_released` | info | Orphan-lock janitor released a balance reservation whose owning intent was no longer in the in-memory queue (typically: process restart recovery, or a TEE-sealed intent that never made it onto the queue) |

### `telemetry.error.changed` — Error Buckets

| Phase | Severity | Description |
|-------|----------|-------------|
| `authorization_failed` | error | Authorization rejected by security enclave |
| `token_metering_failed` | error | T3 execution tokens depleted |
| `settlement_failed` | error | Atomic settlement transaction aborted |
| `service_unavailable` | error | Backend enclave temporarily offline |

## Example: Full Agent Lifecycle

```
[11:02:01] backend_connected       →  API Gateway Connected
[11:02:01] websocket_connected     →  Telemetry Stream Online
[11:02:01] supabase_connected      →  Data Storage Initialized
[11:02:01] t3_sandbox_connected    →  T3 Sandbox Operational
[11:02:02] agent_connected         →  Agent Handshake Initiated
[11:02:02] agent_verifying         →  Verifying Authority
[11:02:03] agent_verified          →  Agent Session Admitted
[11:02:03] intent_received         →  Intent Sealed
[11:02:03] intent_sealed           →  Payload Blinded
[11:02:04] encrypted_evaluation    →  Private Evaluation
[11:02:04] settlement_pending      →  Settlement Initiated
[11:02:05] settlement_finalized    →  Settlement Finalized
[11:02:05] receipt_available       →  Audit Receipt Generated
```

## Client Implementation

### TypeScript/JavaScript

```typescript
class GhostBrokerTelemetryClient {
  private ws: WebSocket;
  
  constructor(institutionId: string) {
    this.ws = new WebSocket(
      `wss://ghostbroker-api.example.com/ws/telemetry?institutionId=${institutionId}`
    );
    
    this.ws.onmessage = (event) => {
      const telemetry = JSON.parse(event.data);
      this.handleEvent(telemetry);
    };
  }
  
  onSettled(callback: (tradeRef: string) => void) {
    this.ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.phase === 'settlement_finalized') {
        callback(data.correlationRef);
      }
    });
  }
  
  onError(callback: (phase: string, message: string) => void) {
    this.ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'telemetry.error.changed') {
        callback(data.phase, data.correlationRef);
      }
    });
  }
}
```

## Security & Privacy

- The telemetry stream emits **no plaintext trading data** — never asset names, quantities, prices, or counterparty identities
- Events are filtered by institution ID — you only see events for your own agents
- Forbidden fields are blocked at the server level before emission
- If a forbidden field is detected, the event is dropped with a security warning
