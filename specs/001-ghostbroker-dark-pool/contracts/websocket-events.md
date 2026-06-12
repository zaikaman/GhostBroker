# WebSocket Events: GhostBroker Telemetry

## Connection

Frontend connects to:

```text
wss://<backend-host>/ws/telemetry
```

The backend authenticates the operator and subscribes the connection only to that operator's institution channel.

## Privacy Rule

Every outbound event must pass an allowlist redactor. Events must never include:

- asset
- side
- quantity
- bid price
- ask price
- execution price plaintext
- active order count
- queue rank
- queue depth
- counterparty identity for active intent
- raw contract arguments
- encrypted payload plaintext
- private keys or secrets

## Event Envelope

```json
{
  "eventId": "evt_01HX...",
  "institutionId": "uuid",
  "type": "telemetry.status.changed",
  "phase": "intent_sealed",
  "severity": "info",
  "timestamp": "2026-06-12T10:00:00.000Z",
  "correlationRef": "opaque_ref"
}
```

## Event Types

### `telemetry.connection.changed`

Used for dashboard connectivity indicators.

Allowed phases:

- `backend_connected`
- `websocket_connected`
- `supabase_connected`
- `t3_sandbox_connected`
- `agent_connected`
- `agent_disconnected`

### `telemetry.agent.changed`

Used for agent admission and authority health.

Allowed phases:

- `agent_verifying`
- `agent_verified`
- `agent_rejected`
- `authority_revoked`

### `telemetry.processing.changed`

Used for encrypted processing indicators.

Allowed phases:

- `intent_received`
- `intent_sealed`
- `encrypted_evaluation`
- `settlement_pending`
- `settlement_finalized`
- `receipt_available`

### `telemetry.error.changed`

Generic error buckets only.

Allowed phases:

- `authorization_failed`
- `token_metering_failed`
- `settlement_failed`
- `service_unavailable`

## Frontend Rendering Contract

The frontend maps phases to generic labels:

| Phase | Dashboard label |
|-------|-----------------|
| `agent_verified` | Agent verified |
| `intent_sealed` | Intent sealed |
| `encrypted_evaluation` | Encrypted evaluation |
| `settlement_pending` | Settlement pending |
| `settlement_finalized` | Settlement finalized |
| `receipt_available` | Receipt available |

The frontend must not infer or display active queue state from missing events. Empty states refer only to completed trade history.
