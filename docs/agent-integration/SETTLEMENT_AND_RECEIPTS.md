# Settlement & Receipts: Tracking Completed Trades

When GhostBroker's TEE matches your agent's intent with a counterparty, the system executes an **atomic settlement** and generates an **encrypted audit receipt**. This guide explains how to track settlements and retrieve receipts.

## Settlement Flow

```
TEE Match Found                    GhostBroker API                    Your Agent
     │                                    │                              │
     │  Execute Settlement                 │                              │
     │  (atomic token swap)                │                              │
     │─────────────────────────────────►   │                              │
     │                                    │                              │
     │  Persist completed_trade           │                              │
     │  + audit_receipts                  │                              │
     │                                    │                              │
     │                                    │  WebSocket: settlement_       │
     │                                    │  finalized + receipt_available│
     │                                    │──────────────────────────────►│
     │                                    │                              │
     │                                    │  Or: Poll GET /api/trades/   │
     │                                    │  completed to find new trade │
     │                                    │◄─────────────────────────────│
     │                                    │                              │
     │                                    │  GET /api/receipts/:id       │
     │                                    │◄─────────────────────────────│
     │                                    │                              │
```

## Method 1: WebSocket Notification (Real-time)

Connect to the telemetry WebSocket and listen for settlement events:

```http
WS /ws/telemetry?institutionId=<your-institution-uuid>
```

When your intent is settled, you'll receive:

```json
{
  "eventId": "evt_01HX...",
  "institutionId": "uuid-here",
  "type": "telemetry.processing.changed",
  "phase": "settlement_finalized",
  "severity": "info",
  "timestamp": "2026-06-12T10:00:00.000Z",
  "correlationRef": "intent_abc123...",
  "agentId": "did:t3n:0xAgentAddress"
}
```

Followed by:

```json
{
  "eventId": "evt_01HY...",
  "institutionId": "uuid-here",
  "type": "telemetry.processing.changed",
  "phase": "receipt_available",
  "severity": "info",
  "timestamp": "2026-06-12T10:00:01.000Z",
  "correlationRef": "intent_abc123...",
  "receiptRef": "uuid-of-receipt"
}
```

The `receiptRef` is the ID you'll use to retrieve the receipt.

## Method 2: Poll Completed Trades

```http
GET /api/trades/completed?from=2026-06-12T00:00:00Z&to=2026-06-12T23:59:59Z
Authorization: Bearer eyJ...
```

**Response** (200):

```json
{
  "items": [
    {
      "id": "uuid",
      "tradeRef": "t3exec_uuid...",
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

**Privacy Note**: Trade fields (`assetCodeCiphertext`, `quantityCiphertext`, `executionPriceCiphertext`) are encrypted. Only the TEE can decrypt them. Your dashboard operator sees them as truncated ciphertext.

## Method 3: Retrieve an Encrypted Receipt

```http
GET /api/receipts/<receipt-uuid>
Authorization: Bearer eyJ...
```

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

### Receipt Fields

| Field | Description |
|-------|-------------|
| `id` | Receipt UUID |
| `completedTradeId` | The trade this receipt belongs to |
| `receiptCiphertext` | Encrypted receipt payload (decrypt with your institution key) |
| `receiptHash` | SHA-256 hash of the plaintext receipt for integrity verification |
| `keyVersion` | Encryption key version used |
| `t3AttestationRef` | TEE attestation reference — can be used to verify execution integrity |

### Receipt Decryption

The receipt ciphertext is encrypted with a key that only your institution can decrypt. Contact your GhostBroker operator to obtain the decryption key for your `keyVersion`.

```typescript
import { decrypt } from '@ghostbroker/agent-client';

const receipt = await apiClient.getReceipt(receiptId);
const plaintext = decrypt(receipt.receiptCiphertext, institutionPrivateKey, receipt.keyVersion);

console.log(JSON.parse(plaintext));
// {
//   "tradeRef": "...",
//   "buyerDid": "did:t3n:...",
//   "sellerDid": "did:t3n:...",
//   "asset": "BTC-USD",
//   "quantity": "10.0",
//   "executionPrice": "69750.00",
//   "settlementHash": "0x...",
//   "t3Attestation": "..."
// }
```

## Failure Handling

If settlement fails, you'll receive a WebSocket event:

```json
{
  "type": "telemetry.error.changed",
  "phase": "settlement_failed",
  "severity": "error",
  "correlationRef": "intent_abc123..."
}
```

Common failure reasons:

| Failure | Description | Recovery |
|---------|-------------|----------|
| `authorization_failed` | Agent authority was revoked before settlement | Re-authenticate with valid delegation |
| `settlement_failed` | Atomic settlement transaction failed | Retry with a new intent |
| `token_metering_failed` | GhostBroker's T3 token balance insufficient | Contact operator to replenish tokens |

## curl Examples

```bash
TOKEN="eyJhbGciOiJIUzI1NiIs..."

# Get completed trades
curl -s http://localhost:3001/api/trades/completed \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/json' | jq '.'

# Get a specific receipt
curl -s http://localhost:3001/api/receipts/<receipt-uuid> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/json' | jq '.'
```
