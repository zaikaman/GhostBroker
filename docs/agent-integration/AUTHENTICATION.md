# Authentication

GhostBroker has two authentication surfaces, each tuned to its consumer:

1. **Agents** (the audience for this doc) authenticate with the API via a persistent **API key** (`gbk_…`). This is the only path the agent SDK supports, because agents are headless and cannot complete a wallet challenge-response.
2. **Operators** (humans) sign in to the dashboard using a Web3 wallet via the Terminal 3 DID challenge-response flow.

The two are not interchangeable: agents use keys, operators use wallets. This page is about the agent side. The operator login is implemented in `frontend/src/services/wallet-auth.ts` and works as long as the backend routes `/api/auth/challenge` and `/api/auth/verify` are reachable.

> **Beyond the session: per-action authority.** The API key authenticates the agent's *session*. Every privileged action — `admit`, `submitIntent`, `cancelIntent`, `settlement.execute` — additionally re-verifies the agent's Ghostbroker-style W3C Verifiable Credential against institution policy. The verifier is the Terminal 3 Agent Auth SDK integration; see the [README § Headline](../../README.md#headline-terminal-3-agent-auth-sdk-integration) and [`t3-enclave/src/auth/ghostbroker-delegation.ts`](../../t3-enclave/src/auth/ghostbroker-delegation.ts). This page covers the *session* layer.

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
Content-Type: application/json

{ "institutionId": "...", "agentDid": "...", "delegationCredential": { ... } }
```

### SDK example

```typescript
import { GhostBrokerClient } from "@ghostbroker/agent-client";
import { readFileSync } from "node:fs";

const client = new GhostBrokerClient({
  baseUrl: "https://api.ghostbroker.io",
});

// One call. The SDK exchanges the key for a session, stores the session
// token, and wires the institution ID into the telemetry WebSocket.
await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);

// The Ghostbroker delegation W3C VC is loaded from disk (or wherever your issuer
// writes it). The backend re-verifies it on every privileged action,
// so this is the only place the agent ever sends the VC.
const delegationCredential = JSON.parse(
  readFileSync(process.env.DELEGATION_CREDENTIAL_PATH!, "utf8"),
);
await client.admitAgent({ institutionId, agentDid, delegationCredential });
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

## Operator dashboard login

The Observatory Console at `/` requires the operator to sign in with a Web3 wallet. The flow is the Terminal 3 DID challenge-response:

1. The dashboard requests a challenge for the operator's DID via `POST /api/auth/challenge`.
2. The browser calls `personal_sign` on the wallet.
3. The signed challenge is posted to `POST /api/auth/verify`, which returns a session token.

The backend verifies the signature using `T3AgentIdentityVerifier` (in [`t3-enclave/src/auth/agent-identity.ts`](../../t3-enclave/src/auth/agent-identity.ts)) and falls back to a live `POST /agent-identity/verify` call on the Terminal 3 network when local verification cannot resolve the wallet from the DID.

This path is **not** exposed by the agent SDK. Agents should never call it — use the API key flow above. It exists because the human-facing dashboard needs a wallet-based login: the operator is the only party in the system who actually holds a wallet and can sign interactively.

> **Why two paths?** The agent SDK deliberately uses a long-lived API key because agents are headless, unattended, and may run across restarts; a wallet challenge on every connection would break them. The operator login deliberately uses a wallet challenge because the operator *is* present and benefits from a one-tap login that ties the session to a wallet the institution controls. Both are real integrations; they just solve different problems.

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
