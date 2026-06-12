# Intent Submission: Submitting Encrypted Trading Orders

Once your agent is admitted (`status: "admitted"`), it can submit **hidden trading intents** — encrypted buy or sell orders that no human or other participant can see.

## Privacy Model

```
Your Agent                          GhostBroker TEE                  Other Participants
     │                                    │                               │
     │  Encrypted Intent Envelope          │                               │
     │  (asset, side, qty, price           │                               │
     │   are all encrypted)                │                               │
     │───────────────────────────────────►│                               │
     │                                    │                               │
     │  Response: intent_handle only      │   No order book visible       │
     │  (opaque reference)                │   No queue depth              │
     │◄───────────────────────────────────│   No counterparty IDs         │
     │                                    │   No price/quantity hints     │
     │                                    │                               │
     │         ── TEE matches silently ──►│◄── (other agent's intent) ── │
     │                                    │                               │
     │  Settlement notification           │                               │
     │  (via WebSocket or poll)           │                               │
     │◄───────────────────────────────────│                               │
```

**Key Rule**: Your intent envelope must be encrypted. GhostBroker will **reject** any submission containing plaintext trading fields like `asset`, `side`, `quantity`, or `price`.

## Step 1: Encrypt Your Order Parameters

Encrypt your trading parameters using a key that only the GhostBroker TEE can decrypt. The exact encryption scheme depends on your TEE contract setup, but the envelope format is:

```typescript
// Pseudocode — encryption happens inside the agent or a T3N client
const encryptedEnvelope = await t3Client.encryptForContract({
  contractId: 'ghostbroker-matching',
  payload: {
    asset: 'BTC-USD',
    side: 'BUY',
    quantity: '10.0',
    limitPrice: '70000.00',
    expirySeconds: 86400,
    allOrNone: true,
  },
});
```

The result is a base64url-encoded ciphertext string.

## Step 2: Submit the Intent

```http
POST /api/agents/intents
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
  "institutionId": "uuid-here",
  "agentDid": "did:t3n:0xAgentAddress",
  "encryptedIntentEnvelope": "<base64url encrypted payload>",
  "authorityRef": "t3-delegation:base64url-vc-id"
}
```

### Request Fields

| Field | Required | Description |
|-------|----------|-------------|
| `institutionId` | Yes | UUID of your institution (from auth response) |
| `agentDid` | Yes | Your agent's `did:t3n:...` identifier |
| `encryptedIntentEnvelope` | Yes | Base64url-encoded encrypted order payload (min 32 chars, max 32KB) |
| `authorityRef` | Yes | The `authorityRef` returned from `POST /api/agents/admit` |

**Response** (202):

```json
{
  "intentHandle": "intent_abc123def456...",
  "state": "intent_sealed"
}
```

The `intentHandle` is your opaque reference to this intent. You cannot derive any order details from it — it's a random hash.

## Step 3: Wait for Settlement

GhostBroker will evaluate your intent against counterparty intents inside the TEE. You have two ways to learn the outcome:

### A. WebSocket Telemetry (Real-time)

```typescript
// Connect to the telemetry WebSocket
const ws = new WebSocket('wss://ghostbroker-api.example.com/ws/telemetry?institutionId=uuid-here');

ws.onmessage = (event) => {
  const telemetry = JSON.parse(event.data);
  
  if (telemetry.phase === 'settlement_finalized' && telemetry.correlationRef === intentHandle) {
    console.log('Intent settled!');
    // Fetch completed trade
  }
  
  if (telemetry.phase === 'settlement_failed' && telemetry.correlationRef === intentHandle) {
    console.log('Intent failed to settle');
  }
};
```

### B. Poll Completed Trades

```http
GET /api/trades/completed?from=2026-06-12T00:00:00Z
Authorization: Bearer eyJ...
```

## What Happens Inside the TEE

1. **Validation**: GhostBroker verifies your agent's authority is still valid and not revoked
2. **Blinding**: The encrypted envelope is stored in TEE volatile memory with an opaque handle
3. **Matching**: The TEE crossing matrix continuously evaluates buy/sell compatibility
4. **Execution**: When a match is found (buy price >= sell price, compatible quantities), the TEE atomically settles
5. **Cleanup**: On settlement or expiry, the intent parameters are purged from TEE memory

## curl Example

```bash
TOKEN="eyJhbGciOiJIUzI1NiIs..."

# Submit an encrypted intent
curl -X POST http://localhost:3001/api/agents/intents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "institutionId": "uuid-here",
    "agentDid": "did:t3n:0xAgentAddress",
    "encryptedIntentEnvelope": "base64url-encrypted-payload-here",
    "authorityRef": "t3-delegation:abc123..."
  }'

# Response:
# {"intentHandle":"intent_abc123...","state":"intent_sealed"}
```

## Important Notes

- **Do not include plaintext trading fields** in the request body. The API validates this and will reject with `validation_failed` if detected.
- **Intents expire** based on the expiry you set in the encrypted payload. Expired intents are silently removed.
- **Revocation**: If your delegation is revoked while an intent is active, the intent will be rejected at matching time.
- **Cancellation**: Contact your GhostBroker operator to cancel active intents (cancellation endpoint coming in a future release).
