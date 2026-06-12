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

## `POST /api/auth/challenge`

Request a cryptographic challenge for DID-based authentication.

**Request Body**:

```json
{
  "did": "did:t3n:0x1234567890abcdef1234567890abcdef12345678"
}
```

**Response** (201):

```json
{
  "challengeId": "auth_challenge_abc123...",
  "challenge": "GhostBroker Terminal 3 DID authorization\nDID: ...",
  "expiresAt": "2026-06-12T10:05:00.000Z"
}
```

---

## `POST /api/auth/verify`

Submit a signed challenge to obtain a session token.

**Request Body**:

```json
{
  "challengeId": "auth_challenge_abc123...",
  "did": "did:t3n:0x1234567890abcdef1234567890abcdef12345678",
  "signature": "0x...",
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
}
```

**Response** (200):

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresAt": "2026-06-12T18:00:00.000Z",
  "institution": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Wallet 0x123456",
    "t3TenantDid": "did:t3n:0x1234567890abcdef1234567890abcdef12345678"
  }
}
```

---

## `POST /api/agents/admit`

Admit an autonomous agent after verifying its delegation credential.

**Auth**: Bearer token (from `/api/auth/verify`)

**Request Body**:

```json
{
  "institutionId": "550e8400-e29b-41d4-a716-446655440000",
  "agentDid": "did:t3n:0xAgentAddress",
  "authorityProof": "{\"version\":\"ghostbroker.delegation-proof/1\",...}"
}
```

**Response** (200):

```json
{
  "agentDid": "did:t3n:0xAgentAddress",
  "status": "admitted",
  "authorityRef": "t3-delegation:abc123..."
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
  "authorityRef": "t3-delegation:abc123..."
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
      "settledAt": "2026-06-12T10:00:00.000Z",
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
  "timestamp": "2026-06-12T10:00:00.000Z",
  "correlationRef": "opaque_ref",
  "agentId": "did:t3n:0x..."
}
```

**Event Types**: See [WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md) for full event reference.

---

## Common Headers

All authenticated requests require:

```
Authorization: Bearer <jwt-token>
Accept: application/json
```

Development-mode requests can use header-based auth:

```
x-operator-institution-id: <uuid>
x-operator-id: optional-operator-id
```
