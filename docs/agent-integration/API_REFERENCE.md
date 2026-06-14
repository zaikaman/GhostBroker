# GhostBroker REST API Reference

**Base URL**: `https://ghostbroker-api.herokuapp.com` (production) or `http://localhost:3001` (local development)

**Full OpenAPI Spec**: See [specs/001-ghostbroker-dark-pool/contracts/openapi.yaml](../specs/001-ghostbroker-dark-pool/contracts/openapi.yaml)

---

## `GET /api/health`

Service health check. No authentication required.

**Response** (200):

```json
{
  "status": "ok",
  "services": {
    "backend": "ok",
    "supabase": "ok",
    "websocket": "ok",
    "t3_enclave": "ok"
  }
}
```

---

## `POST /api/institutions`

Create a new institutional profile. Used during onboarding.

**Request Body**:

```json
{
  "legalName": "JPMorgan Chase & Co.",
  "displayName": "JPMorgan",
  "settlementProfileRef": "settlement:default"
}
```

**Response** (201):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "legalName": "JPMorgan Chase & Co.",
  "displayName": "JPMorgan",
  "status": "active",
  "t3TenantDid": "did:t3n:0x..."
}
```

---

## `POST /api/auth/api-key` (agent authentication)

Exchange a persistent API key for an 8-hour session token. This is the only authentication flow supported by the agent SDK.

**Request Body**:

```json
{
  "apiKey": "gbk_..."
}
```

**Response** (200):

```json
{
  "token": "gb_session_abc123...",
  "expiresAt": "2026-06-14T20:00:00.000Z",
  "institution": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "JPMorgan",
    "t3TenantDid": "did:t3n:0x..."
  }
}
```

**Errors**:
- `400 validation_failed` — body missing `apiKey` or `apiKey` is empty
- `401 authorization_failed` — the key is unknown, revoked, or malformed

> **Note on `/api/auth/challenge` and `/api/auth/verify`**: those routes exist for the dashboard's operator login (Web3 wallet → session). Agents should not call them — use `/api/auth/api-key` instead. See [Authentication](./AUTHENTICATION.md) for details.

---

## `POST /api/agents/admit`

Admit an autonomous agent after verifying its delegation credential.

**Auth**: Bearer token (from `/api/auth/api-key`)

**Request Body**:

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentDid": "did:t3n:0xAgentAddress",
  "delegationCredential": {
    "id": "urn:uuid:ghostbroker-delegation-...",
    "type": ["VerifiableCredential", "GhostBrokerDelegation"],
    "issuer": "did:t3n:0x...",
    "issuanceDate": "...",
    "expirationDate": "...",
    "credentialSubject": { ... },
    "proof": { ... }
  }
}
```

**Response** (200):

```json
{
  "agentDid": "did:t3n:0xAgentAddress",
  "status": "admitted",
  "authorityRef": "boundbuyer-delegation:urn:uuid:ghostbroker-delegation-..."
}
```

**Error** (403):

```json
{
  "code": "authorization_failed",
  "message": "Authorization failed. Request rejected by the security enclave."
}
```

---

## `POST /api/agents/intents`

Submit an encrypted hidden trading intent.

**Auth**: Bearer token

**Request Body**:

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentDid": "did:t3n:0xAgentAddress",
  "encryptedIntentEnvelope": "<base64url encrypted payload>",
  "authorityRef": "boundbuyer-delegation:urn:uuid:ghostbroker-delegation-..."
}
```

**Response** (202):

```json
{
  "intentHandle": "intent_abc123def456...",
  "state": "intent_sealed"
}
```

**Requirements**:
- `encryptedIntentEnvelope` must be 32–32768 characters, base64url-encoded
- No plaintext trading fields (`asset`, `side`, `quantity`, `price`) allowed in request body
- A balance reservation is acquired on the institution's available balance before the 202 is returned. If the institution has insufficient available balance (considering all other pending intents), the response is **403 `authorization_failed`** and no intent is queued.

---

## `POST /api/agents/intents/cancel`

Cancel a previously submitted intent that is still pending in the matching orchestrator.

**Auth**: Bearer token

**Request Body**:

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentDid": "did:t3n:0xAgentAddress",
  "intentHandle": "intent_abc123def456...",
  "authorityRef": "boundbuyer-delegation:urn:uuid:ghostbroker-delegation-..."
}
```

**Response** (200):

```json
{
  "intentHandle": "intent_abc123def456...",
  "state": "intent_cancelled"
}
```

**Errors**:
- `400 validation_failed` — body missing required fields
- `401 authorization_failed` — missing or invalid bearer token
- `403 authorization_failed` — caller's agentDid does not own the intent, or authority proof is invalid/revoked
- `404 not_found` — the intent handle is not in the pending queue (already matched, expired, never existed, or owned by a different agent)

> The cancel does not reverse a settled trade. It only removes the intent from the matching queue and releases the balance lock. Cancellation is agent-initiated; operators who need to invalidate an agent's pending intents should use `POST /api/agents/:id/revoke` instead.

---

## `GET /api/agents/intents`

List the institution's currently-pending intents. The list is always institution-scoped (from the bearer token) and never crosses institutions.

**Auth**: Bearer token

**Query Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentDid` | DID | No | Filter to a single agent's pending intents |

**Response** (200):

```json
{
  "intents": [
    {
      "intentHandle": "intent_abc123def456...",
      "correlationRef": "opaque_ref",
      "agentDid": "did:t3n:0xAgentAddress",
      "assetCode": "WBTC",
      "side": "buy",
      "quantity": 100,
      "price": 45000,
      "sealedAt": "2026-06-14T10:00:00.000Z"
    }
  ]
}
```

**Errors**:
- `400 validation_failed` — `agentDid` is malformed
- `401 authorization_failed` — missing or invalid bearer token

> The view strips the encrypted envelope, the authority reference, and the agent's authority limits. These are private to the matching engine; exposing them through this endpoint could reveal authorization policies.

---

## `GET /api/portfolios/{institutionId}`

Retrieve the institution's portfolio.

**Auth**: Bearer token
**Path Parameter**: `institutionId` — UUID of the institution (must match the bearer token's institution)

**Query Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentDid` | DID | No | When present, returns the agent-level view (DB-only, with pending reservations for that agent) instead of the operator view (which may include live wallet sync) |

**Response (operator view, no `agentDid`)** (200):

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "holdings": [
    { "assetCode": "USDC", "balance": 1000000, "locked": 0 },
    { "assetCode": "WBTC", "balance": 5, "locked": 0 }
  ]
}
```

**Response (agent view, with `agentDid`)** (200):

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentDid": "did:t3n:0xAgentAddress",
  "holdings": [
    { "assetCode": "USDC", "balance": 1000000, "locked": 100000 },
    { "assetCode": "WBTC", "balance": 5, "locked": 0 }
  ],
  "pendingReservations": [
    {
      "intentHandle": "intent_buy_1",
      "assetCode": "USDC",
      "amount": 100000,
      "side": "buy",
      "quantity": 2,
      "price": 50000
    }
  ]
}
```

**Errors**:
- `400 validation_failed` — `agentDid` is malformed
- `401 authorization_failed` — missing or invalid bearer token
- `403 authorization_failed` — querying another institution's portfolio

> Each holding's `balance` is the institution's total balance; `locked` is the portion reserved by pending intents; the agent's *available* balance is `balance - locked`. Reservations are automatically released on cancel, agent revocation, intent expiry, and (implicitly) on settlement.

---

## `GET /api/trades/completed`

List completed trades for the authenticated institution.

**Auth**: Bearer token

**Query Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | ISO 8601 | No | Earliest settlement time (inclusive) |
| `to` | ISO 8601 | No | Latest settlement time (inclusive) |

**Response** (200):

```json
{
  "items": [
    {
      "id": "uuid",
      "tradeRef": "t3exec_abc123...",
      "assetCodeCiphertext": "t3cipher.abc...sealed",
      "quantityCiphertext": "t3cipher.def...sealed",
      "executionPriceCiphertext": "t3cipher.ghi...sealed",
      "settledAt": "2026-06-14T10:00:00.000Z",
      "settlementStatus": "settled",
      "receiptIds": ["uuid-of-receipt"]
    }
  ]
}
```

---

## `GET /api/receipts/{receiptId}`

Retrieve an encrypted audit receipt.

**Auth**: Bearer token
**Path Parameter**: `receiptId` — UUID of the receipt

**Response** (200):

```json
{
  "id": "uuid",
  "completedTradeId": "uuid",
  "receiptCiphertext": "<encrypted receipt payload>",
  "receiptHash": "sha256-hash",
  "keyVersion": "v1",
  "t3AttestationRef": "t3-attest:abc123..."
}
```

**Error** (404):

```json
{
  "code": "not_found",
  "message": "Requested resource was not found."
}
```

---

## `WS /ws/telemetry`

Real-time telemetry WebSocket for agent monitoring.

**Connection**: `wss://host/ws/telemetry?institutionId=<uuid>`

**Event Format**:

```json
{
  "eventId": "evt_01HX...",
  "institutionId": "uuid",
  "type": "telemetry.agent.changed",
  "phase": "agent_verified",
  "severity": "info",
  "timestamp": "2026-06-14T10:00:00.000Z",
  "correlationRef": "opaque_ref",
  "agentId": "did:t3n:0x..."
}
```

**Event Types**: See [WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md) for full event reference.

---

## Common Headers

All authenticated requests require:

```
Authorization: Bearer ***
Accept: application/json
```

Development-mode requests can use header-based auth:

```
x-operator-institution-id: <uuid>
x-operator-id: optional-operator-id
```
