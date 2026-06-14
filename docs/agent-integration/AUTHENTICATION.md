# Agent Authentication

GhostBroker supports two authentication paths for autonomous agents. The **API key** path is the recommended default for production agents; the **DID challenge-response** path is the alternative for agents that already have a Terminal 3 keypair and prefer to authenticate cryptographically without holding a long-lived secret.

Both paths return the same `AuthSession` shape — `{ token, expiresAt, institution }` — and the issued token is interchangeable on every other endpoint.

## Quick comparison

| | API key (recommended) | DID challenge-response |
|---|---|---|
| Credential | `gbk_…` key from the dashboard | Terminal 3 wallet keypair |
| Exchange | `POST /api/auth/api-key` | `POST /api/auth/challenge` + `POST /api/auth/verify` |
| Credential lifetime | Persistent until you revoke it | Per-session (one challenge) |
| Session token lifetime | 8 hours | 8 hours |
| Requires wallet signature | No | Yes (EIP-191) |
| Best for | Long-running agents, CI/CD, Docker deployments | Wallets that already hold a T3 keypair |

---

## Option A — API key (recommended)

### How it works

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

The raw API key is only sent **once** — to exchange it for a session. Subsequent requests use the short-lived session token, so the key never has to be carried on the wire again until the session expires (8 hours).

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

The session token is the same shape as the DID-flow token and is accepted on every other endpoint via `Authorization: Bearer <token>`.

### Step 2: Use the session token

```http
POST /api/agents/admit
Authorization: Bearer ***
Content-Type: application/json

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

### Session lifecycle

- **Key**: persistent until revoked from the dashboard.
- **Session**: 8 hours. The SDK does not auto-refresh — your code should re-invoke `authenticateWithApiKey()` on 401 responses. The next call exchanges the same key for a fresh session.

---

## Option B — DID challenge-response (alternative)

Use this path if your agent already holds a Terminal 3 keypair and you want a credential flow that does not require a long-lived API secret.

### How it works

```
Agent                              GhostBroker API
  │                                      │
  │  1. POST /api/auth/challenge         │
  │  { "did": "..." }                    │
  │─────────────────────────────────────►│
  │                                      │
  │  ← { challengeId, challenge, exp }   │
  │◄─────────────────────────────────────│
  │                                      │
  │  2. Sign challenge with private key  │
  │     (EIP-191 personal_sign)          │
  │                                      │
  │  3. POST /api/auth/verify            │
  │  { challengeId, signature, ... }     │
  │─────────────────────────────────────►│
  │                                      │
  │  ← { token, expiresAt, institution } │
  │◄─────────────────────────────────────│
  │                                      │
  │  4. Use Bearer token for all calls   │
```

### Prerequisites

- A Terminal 3 Ethereum keypair (private key + address)
- Your institution's DID (shown in the dashboard)
- `ethers` v6 (or any EIP-191 compatible signing library)

### Step 1: Request a challenge

```http
POST /api/auth/challenge
Content-Type: application/json

{ "did": "did:t3n:0xYourInstitutionAddress" }
```

Response:
```json
{
  "challengeId": "ch_abc123",
  "challenge": "GhostBroker Terminal 3 DID authorization\nDID: did:t3n:0x...\nNonce: ...",
  "expiresAt": "2026-06-14T12:00:00.000Z"
}
```

### Step 2: Sign the challenge

```typescript
import { Wallet } from "ethers";

const agent = new Wallet("0xYourAgentPrivateKey");
const signature = await agent.signMessage(challenge);
// signMessage automatically applies EIP-191 personal_sign wrapping
```

### Step 3: Verify the signature

```http
POST /api/auth/verify
Content-Type: application/json

{
  "did": "did:t3n:0xYourInstitutionAddress",
  "challengeId": "ch_abc123",
  "signature": "0x...",
  "walletAddress": "0xYourAgentAddress"
}
```

Response:
```json
{
  "token": "gb_session_abc123",
  "expiresAt": "2026-06-14T20:00:00.000Z",
  "institution": {
    "id": "uuid-here",
    "displayName": "Your Institution",
    "t3TenantDid": "did:t3n:0x..."
  }
}
```

### SDK example

```typescript
import { Wallet } from "ethers";
import { GhostBrokerClient } from "@ghostbroker/agent-client";

const wallet = new Wallet(process.env.AGENT_PRIVATE_KEY!);

const client = new GhostBrokerClient({ baseUrl: "https://api.ghostbroker.io" });

await client.authenticate(wallet.address, async (challenge) => ({
  signature: await wallet.signMessage(challenge),
  walletAddress: wallet.address,
}));
```

### Session lifecycle

- **Credential**: ephemeral (the keypair is yours, but the challenge is one-time).
- **Session**: 8 hours. Re-run the challenge/verify flow to get a new session.

---

## Pre-existing session

If you already have a session token (e.g. a long-running agent that has persisted it to disk), you can hand it to the client directly. The optional `institutionId` wires the telemetry WebSocket filter correctly without an extra round-trip.

```typescript
const client = new GhostBrokerClient({
  baseUrl: "https://api.ghostbroker.io",
  token: cachedSessionToken,
  institutionId: cachedInstitutionId,
});
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `400 validation_failed` (api-key) | Missing `apiKey` in body, or empty string | Ensure body is `{ "apiKey": "gbk_..." }` with a non-empty key |
| `401 authorization_failed` (api-key) | Unknown, revoked, or malformed key | Generate a new key from the dashboard API Keys panel |
| `401 authorization_failed` (challenge) | DID not recognized | Verify your DID matches the one in the dashboard |
| `401 authorization_failed` (verify) | Challenge expired (5 min TTL) or wrong signature | Request a new challenge; ensure your signer uses EIP-191 personal_sign |
| `403 authorization_failed` (verify) | Identity verifier rejected the signature | Confirm the wallet is the one bound to the DID |
| Token rejected mid-session | Session token expired (8h TTL) | Re-run the authentication flow; for the API key path, call `client.authenticateWithApiKey()` again with the same key |
| Telemetry WebSocket receives nothing | `institutionId` is empty | Always pass `institutionId` from the session, or call `authenticate()` / `authenticateWithApiKey()` to populate it |

## See also

- [API Reference](./API_REFERENCE.md) — full endpoint list and request shapes
- [Deploy Your Agent](./DEPLOY_YOUR_AGENT.md) — end-to-end agent deployment walkthrough
- [WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md) — event types and the `institutionId` query parameter
- [Error Reference](./ERROR_REFERENCE.md) — full list of redacted error codes
