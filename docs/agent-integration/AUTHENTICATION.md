# Authentication

GhostBroker has two distinct authentication surfaces:

1. **Agents** authenticate with the API via a persistent **API key** (`gbk_…`). This is the only path the agent SDK supports.
2. **Operators** sign in to the dashboard using a Web3 wallet via the DID challenge-response flow. This is an internal dashboard concern, not part of the agent API contract.

The two are not interchangeable: agents use keys, operators use wallets. This page is about the agent side. The dashboard login is implemented in `frontend/src/services/wallet-auth.ts` and works as long as the backend routes `/api/auth/challenge` and `/api/auth/verify` are reachable.

## Agent authentication: API key (the only supported path)

```
Agent                                GhostBroker API
  │                                          │
  │  POST /api/auth/api-key                  │
  │  { "apiKey": "gbk_..." }                 │
  │─────────────────────────────────────────►│
  │                                          │
  │  ← { token, expiresAt, institution }     │
  │◄─────────────────────────────────────────│
  │                                          │
  │  Use Bearer token for all API calls      │
```

The raw API key is sent **once** — to exchange it for a session token. Subsequent requests carry the short-lived session token, so the key never has to be on the wire again until the session expires (8 hours).

### Prerequisites

- A GhostBroker institution (created on first dashboard login)
- An API key — generate one from the **API Keys** panel on the dashboard

### Step 1: Exchange the key for a session

```http
POST /api/auth/api-key
Content-Type: application/json

{
  "apiKey": "gbk_..."
}
```

Response:
```json
{
  "token": "gb_session_abc123",
  "expiresAt": "2026-06-14T20:00:00.000Z",
  "institution": {
    "id": "00000000-0000-4000-8000-000000000101",
    "displayName": "Northstar Capital",
    "t3TenantDid": "did:t3n:0x..."
  }
}
```

The session token is accepted on every other endpoint via `Authorization: Bearer *** Step 2: Use the session token

```http
POST /api/agents/admit
Authorization: Bearer ***
C...ype: application/json

{ "institutionId": "...", "agentDid": "...", "authorityProof": "..." }
```

### SDK example

```typescript
import { GhostBrokerClient } from "@ghostbroker/agent-client";

const client = new GhostBrokerClient({
  baseUrl: "https://api.ghostbroker.io",
});

// One call. The SDK exchanges the key for a session, stores the session
// token, and wires the institution ID into the telemetry WebSocket.
await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);

// Every subsequent call uses the session token automatically:
await client.admitAgent({ institutionId, agentDid, authorityProof });
await client.submitIntent({ institutionId, agentDid, encryptedIntentEnvelope, authorityRef });

client.telemetry.onSettled((ref) => console.log("Settled:", ref));
client.telemetry.connect();
```

### Pre-existing session

If you already have a session token (e.g. a long-running agent that has persisted it to disk), you can hand it to the client directly. The optional `institutionId` wires the telemetry WebSocket filter correctly without an extra round-trip.

```typescript
const client = new GhostBrokerClient({
  baseUrl: "https://api.ghostbroker.io",
  token: cachedSessionToken,
  institutionId: cachedInstitutionId,
});
```

### Session lifecycle

- **Key**: persistent until revoked from the dashboard.
- **Session**: 8 hours. The SDK does not auto-refresh — your code should re-invoke `authenticateWithApiKey()` on 401 responses. The next call exchanges the same key for a fresh session.

---

## Operator dashboard login (internal)

The Observatory Console at `/` requires the operator to sign in with a Web3 wallet. The flow is the Terminal 3 DID challenge-response:

1. The dashboard requests a challenge for the operator's DID via `POST /api/auth/challenge`.
2. The browser calls `personal_sign` on the wallet.
3. The signed challenge is posted to `POST /api/auth/verify`, which returns a session token.

This path is **not** exposed by the agent SDK. Agents should never call it — use the API key flow above. The backend routes are kept available only because the dashboard needs them.

> **Why is this here?** The DID routes are part of the backend's HTTP surface for legacy/compatibility reasons. New agent code should always use `/api/auth/api-key`. If you are writing an agent, you can ignore this section.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `400 validation_failed` (api-key) | Missing `apiKey` in body, or empty string | Ensure body is `{ "apiKey": "gbk_..." }` with a non-empty key |
| `401 authorization_failed` (api-key) | Unknown, revoked, or malformed key | Generate a new key from the dashboard API Keys panel |
| `401 authorization_failed` (dashboard login) | Wallet signature didn't match the challenge | Ensure the wallet holds the address shown in the dashboard; try disconnecting and reconnecting the wallet |
| `403 authorization_failed` (dashboard login) | Identity verifier rejected the signature | Confirm the wallet is the one bound to the institution |
| Token rejected mid-session | Session token expired (8h TTL) | Re-run `client.authenticateWithApiKey()` with the same key |
| Telemetry WebSocket receives nothing | `institutionId` is empty | Always pass `institutionId` from the session, or call `authenticateWithApiKey()` to populate it |

## See also

- [API Reference](./API_REFERENCE.md) — full endpoint list and request shapes
- [Deploy Your Agent](./DEPLOY_YOUR_AGENT.md) — end-to-end agent deployment walkthrough
- [WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md) — event types and the `institutionId` query parameter
- [Error Reference](./ERROR_REFERENCE.md) — full list of redacted error codes
