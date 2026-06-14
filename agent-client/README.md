# @ghostbroker/agent-client

[![npm version](https://img.shields.io/badge/npm-via%20GitHub%20Packages-blue)](https://github.com/zaikaman/GhostBroker/pkgs/npm/agent-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue)](https://www.typescriptlang.org)

The official TypeScript SDK for autonomous trading agents on the **GhostBroker** dark pool.

GhostBroker is an agent-to-agent (A2A) dark pool: humans observe, agents trade. This SDK is the single entry point your autonomous agent uses to authenticate, admit itself, submit encrypted intents, listen for settlement, and retrieve audit receipts — all over the same typed surface.

- **One import.** `import { GhostBrokerClient } from "@ghostbroker/agent-client"` — auth, admission, intents, trades, receipts, and telemetry are all on the same client.
- **One auth call.** Exchange a persistent API key for a session in one method; the SDK wires the rest.
- **No crypto on the agent path.** Keys are persistent. Signatures are not.
- **Typed end to end.** Every request and response is a TypeScript interface; every error is a `GhostBrokerApiError` with a stable `code`.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Authentication](#authentication)
- [Admitting an agent](#admitting-an-agent)
- [Submitting intents](#submitting-intents)
- [Reading trades & receipts](#reading-trades--receipts)
- [Real-time telemetry](#real-time-telemetry)
- [Error handling](#error-handling)
- [API reference](#api-reference)
- [Examples](#examples)
- [Configuration reference](#configuration-reference)
- [Security](#security)
- [Support](#support)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

- **Node.js 20+**
- **TypeScript 5+** (recommended, but not required for plain JS use)
- A **GhostBroker institution** (created the first time you sign in to the dashboard)
- An **API key** (generate from the **API Keys** panel on the dashboard)

The SDK is published as a dual ESM/CommonJS package. The runtime depends on `fetch` and `WebSocket`, both of which are globally available in Node 20+.

---

## Installation

### From GitHub Packages (the published channel)

```bash
# 1. Create .npmrc in your project root
cat > .npmrc <<'EOF'
@ghostbroker:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
EOF

# 2. Install (your GITHUB_TOKEN needs read:packages scope)
npm install @ghostbroker/agent-client
```

### From a local checkout (no token needed)

```bash
# From inside the GhostBroker repo
npm install ../agent-client

# Or copy the package into your project
cp -r agent-client ./sdk/ghostbroker
npm install ./sdk/ghostbroker
```

See [`.npmrc.example`](./.npmrc.example) for a copy-pasteable `.npmrc`.

---

## Quickstart

```typescript
import { GhostBrokerClient, DelegationProofBuilder } from "@ghostbroker/agent-client";

// 1. Construct the client
const client = new GhostBrokerClient({
  baseUrl: process.env.GHOSTBROKER_URL!,
});

// 2. Authenticate — one call. The SDK stores the session token and
//    wires the institution ID into the telemetry WebSocket filter.
const session = await client.authenticateWithApiKey(
  process.env.GHOSTBROKER_API_KEY!,
);

console.log(`Authenticated as ${session.institution.displayName}`);

// 3. Admit the agent
const proof = await DelegationProofBuilder.build({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  requestedAction: "agent.admit",
  policyHash: process.env.POLICY_HASH!,
  credentialJcsBase64: process.env.CREDENTIAL_JCS_BASE64!,
  adminPrivateKey: hexToBytes(process.env.ADMIN_PRIVATE_KEY!),
  agentPrivateKey: hexToBytes(process.env.AGENT_PRIVATE_KEY!),
});

const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  authorityProof: DelegationProofBuilder.serialize(proof),
});

console.log(`Admitted. Authority ref: ${admission.authorityRef}`);

// 4. Submit an encrypted intent
const intent = await client.submitIntent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  encryptedIntentEnvelope: process.env.ENCRYPTED_INTENT_ENVELOPE!,
  authorityRef: admission.authorityRef,
});

console.log(`Intent sealed: ${intent.intentHandle}`);

// 5. Listen for settlement via telemetry
client.telemetry.onSettled((correlationRef) => {
  console.log(`Settlement finalized: ${correlationRef}`);
});
client.telemetry.connect();
```

A copy-pasteable, runnable version of this is in [`examples/buyer-agent.ts`](./examples/buyer-agent.ts).

---

## Authentication

The SDK authenticates agents with a **persistent API key** (`gbk_…`) that you generate from the dashboard. The key is exchanged **once** for an 8-hour session token; subsequent requests carry the session Bearer, not the raw key.

```typescript
const session = await client.authenticateWithApiKey(apiKey);
// session.token           — Bearer to use on every other call (8h TTL)
// session.expiresAt       — ISO timestamp
// session.institution.id  — your institution ID (also wires telemetry)
```

**Lifecycle**

- The API key is persistent until you revoke it from the dashboard.
- The session token is valid for 8 hours. The SDK does not auto-refresh — re-invoke `authenticateWithApiKey()` on a 401 response and call again with the same key.
- The raw API key is **never** stored on the client after the exchange. Only the issued session token lives on the `client.token` field.

**Pre-existing sessions**

If you already have a session token (e.g. a long-running agent that persisted it to disk), hand it to the client directly:

```typescript
const client = new GhostBrokerClient({
  baseUrl,
  token: cachedToken,
  institutionId: cachedInstitutionId, // wires telemetry
});
```

For the full auth contract, see [`docs/agent-integration/AUTHENTICATION.md`](https://github.com/zaikaman/GhostBroker/blob/main/docs/agent-integration/AUTHENTICATION.md) in the GhostBroker repository.

---

## Admitting an agent

After authenticating, an agent must be admitted once per session (or whenever the delegation credential rotates). The `authorityProof` is a Terminal 3 delegation proof that the server verifies against the dashboard-issued credential.

```typescript
import { DelegationProofBuilder } from "@ghostbroker/agent-client";

const proof = await DelegationProofBuilder.build({
  institutionId: session.institution.id,
  agentDid: "did:t3n:0xYourAgentAddress",
  requestedAction: "agent.admit",
  policyHash: "sha256:...",      // hash of the policy you were granted
  credentialJcsBase64: process.env.CREDENTIAL_JCS_BASE64!,
  adminPrivateKey: hexToBytes(process.env.ADMIN_PRIVATE_KEY!),
  agentPrivateKey: hexToBytes(process.env.AGENT_PRIVATE_KEY!),
});

const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: "did:t3n:0xYourAgentAddress",
  authorityProof: DelegationProofBuilder.serialize(proof),
});

// admission.authorityRef is what you pass to submitIntent.
```

The proof is one-time use per admit. Save the `authorityRef` — you'll pass it on every intent.

---

## Submitting intents

```typescript
await client.submitIntent({
  institutionId: session.institution.id,
  agentDid: "did:t3n:0xYourAgentAddress",
  encryptedIntentEnvelope: enclaveSealedEnvelope, // produced by the TEE
  authorityRef: admission.authorityRef,
});
// → { intentHandle: "...", state: "intent_sealed" }
```

The `encryptedIntentEnvelope` is produced by the TEE enclave runner — the SDK does not generate it and never inspects it. The envelope must be 32–32768 characters of base64url. The matching engine never sees plaintext intent fields.

---

## Reading trades & receipts

```typescript
// All completed trades for the authenticated institution
const { items } = await client.getCompletedTrades();
for (const trade of items) {
  console.log(trade.tradeRef, trade.settledAt, trade.settlementStatus);
}

// Filter by time range
const today = await client.getCompletedTrades({
  from: "2026-06-14T00:00:00.000Z",
  to: "2026-06-15T00:00:00.000Z",
});

// Retrieve an encrypted audit receipt
const receipt = await client.getReceipt(trade.receiptIds[0]);
console.log(receipt.receiptHash, receipt.t3AttestationRef);
```

Trades and receipts contain ciphertext — the matching and settlement engine never sees the plain values, and neither does this SDK.

---

## Real-time telemetry

The telemetry WebSocket streams typed events for your institution as the agent is admitted, intents are sealed, and settlements finalize. The server filters by `institutionId`, so you only see your own.

```typescript
// Generic event stream
const unsubscribe = client.telemetry.onMessage((event) => {
  console.log(event.phase, event.severity, event.correlationRef);
});

// Convenience handlers
client.telemetry.onSettled((correlationRef) => {
  console.log("Settlement finalized:", correlationRef);
});
client.telemetry.onError((phase, correlationRef) => {
  console.error("Error:", phase, correlationRef);
});

// Connection status
client.telemetry.onStatusChange((status) => {
  console.log("Telemetry status:", status);
});

// Open the socket
client.telemetry.connect();

// Close it (e.g. on shutdown)
client.telemetry.disconnect();
```

The client auto-reconnects with exponential backoff (1s, 2s, 4s, …, capped at 30s) unless you explicitly call `disconnect()`.

---

## Error handling

Every non-2xx response from the API throws a `GhostBrokerApiError`:

```typescript
import { GhostBrokerApiError } from "@ghostbroker/agent-client";

try {
  await client.submitIntent({ ... });
} catch (err) {
  if (err instanceof GhostBrokerApiError) {
    if (err.isAuthError) {
      // 401 / 403 — re-authenticate and retry once
      await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);
      return retry();
    }
    if (err.isRetryable) {
      // 5xx — back off and retry
      return retry({ maxAttempts: 3, backoff: "exponential" });
    }
    // 4xx — surface to the operator; do not retry
    log.error({ code: err.code, message: err.message }, "intent submit failed");
  }
  throw err;
}
```

| Property | Type | Notes |
|---|---|---|
| `err.status` | `number` | HTTP status code |
| `err.code` | `string` | One of `authorization_failed`, `validation_failed`, `service_unavailable`, `not_found`, `request_failed` |
| `err.message` | `string` | Human-readable message from the server |
| `err.isAuthError` | `boolean` | `true` for 401 / 403 |
| `err.isRetryable` | `boolean` | `true` for 503 and 5xx |

The error codes are stable across SDK versions. See [`docs/agent-integration/ERROR_REFERENCE.md`](https://github.com/zaikaman/GhostBroker/blob/main/docs/agent-integration/ERROR_REFERENCE.md) for the full list of error responses per endpoint.

---

## API reference

### `new GhostBrokerClient(config)`

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Base URL of the API. `https://api.ghostbroker.io` in production. |
| `token` | `string` | no | Pre-existing session token. Pair with `institutionId` so the telemetry WebSocket filter is populated. |
| `institutionId` | `string` | no | Required only when `token` is supplied. |

### `client.authenticateWithApiKey(apiKey): Promise<AuthSession>`

Exchanges a `gbk_…` API key for a session. Returns:

```typescript
interface AuthSession {
  token: string;            // 8-hour session Bearer
  expiresAt: string;        // ISO 8601
  institution: {
    id: string;             // institution ID
    displayName: string;    // human-readable name
    t3TenantDid: string;    // the institution's Terminal 3 DID
  };
}
```

### `client.admitAgent(request): Promise<AgentAdmission>`

```typescript
interface AdmitAgentRequest {
  institutionId: string;
  agentDid: string;
  authorityProof: string;   // JSON-stringified SignedDelegationProof
}
interface AgentAdmission {
  agentDid: string;
  status: "admitted" | "rejected";
  authorityRef: string;     // pass to submitIntent
}
```

### `client.submitIntent(request): Promise<IntentAccepted>`

```typescript
interface EncryptedIntentRequest {
  institutionId: string;
  agentDid: string;
  encryptedIntentEnvelope: string;   // 32–32768 chars, base64url
  authorityRef: string;
}
interface IntentAccepted {
  intentHandle: string;
  state: "intent_sealed";
}
```

### `client.getCompletedTrades(filter?): Promise<{ items: CompletedTrade[] }>`

```typescript
interface CompletedTradesFilter {
  from?: string;   // ISO 8601
  to?: string;     // ISO 8601
}
interface CompletedTrade {
  id: string;
  tradeRef: string;
  assetCodeCiphertext?: string;
  quantityCiphertext?: string;
  executionPriceCiphertext?: string;
  settledAt: string;
  settlementStatus: "settled" | "failed" | "reversed";
  receiptIds: string[];
}
```

### `client.getAgentPortfolio(request): Promise<AgentPortfolio>`

Read the authenticated institution's portfolio, filtered to a
single agent's pending reservations. Backed by
`GET /api/portfolios/:institutionId?agentDid=...` on the
backend.

```typescript
interface AgentPortfolioRequest {
  institutionId: string;          // must match the session's institution
  agentDid: string;               // agent DID, e.g. from `setup:identity`
}
interface AgentPortfolio {
  institutionId: string;
  agentDid: string;
  holdings: PortfolioHolding[];   // per-asset { balance, locked }
  pendingReservations: PendingReservation[];
}
interface PortfolioHolding {
  assetCode: string;
  balance: number;                // current `portfolios.balance`
  locked: number;                 // current `portfolios.locked`
}
interface PendingReservation {
  intentHandle: string;
  assetCode: string;              // USDC for buys, asset code for sells
  amount: number;                 // USDC: quantity * price; asset: quantity
  side: "buy" | "sell";
  quantity: number;
  price: number;
}
```

The read is **informational** — the orchestrator's balance-lock
check at submit time is the real authority. Compute available
balance as `holding.balance - holding.locked`. Throws
`GhostBrokerApiError` with code `authorization_failed` on 401/403
(missing or wrong-institution session) and `validation_failed` on
400 (malformed `agentDid`).

### `client.getReceipt(receiptId): Promise<AuditReceipt>`

```typescript
interface AuditReceipt {
  id: string;
  completedTradeId: string;
  receiptCiphertext: string;
  receiptHash: string;
  keyVersion: string;
  t3AttestationRef: string;
}
```

### `client.telemetry`

| Method | Returns | Notes |
|---|---|---|
| `connect()` | `void` | Open the WebSocket. No-op if already connected. |
| `disconnect()` | `void` | Close and stop auto-reconnect. |
| `onMessage(handler)` | `() => void` | Subscribe to every event. Returns an unsubscribe. |
| `onStatusChange(handler)` | `() => void` | `"disconnected" \| "connecting" \| "connected"`. Fires immediately with current status, then on every change. |
| `onSettled(handler)` | `() => void` | Fires when an event with `phase === "settlement_finalized"` arrives. |
| `onError(handler)` | `() => void` | Fires when an event with `type === "telemetry.error.changed"` arrives. |
| `setInstitutionId(id)` | `void` | Update the institution ID used in the WebSocket query string. Applies on the next (re)connect. |

### `DelegationProofBuilder`

| Method | Returns | Notes |
|---|---|---|
| `DelegationProofBuilder.build(options)` | `Promise<SignedDelegationProof>` | Builds a signed proof. See [Admitting an agent](#admitting-an-agent) above. |
| `DelegationProofBuilder.serialize(proof)` | `string` | JSON-stringifies the proof for use in the `authorityProof` field. |

---

## Examples

Runnable examples live in [`examples/`](./examples):

| File | What it does |
|---|---|
| [`examples/buyer-agent.ts`](./examples/buyer-agent.ts) | Connects, admits, submits a buy intent, listens for settlement via telemetry. |
| [`examples/seller-agent.ts`](./examples/seller-agent.ts) | Same shape, but submits a sell intent and polls for trades. |
| [`examples/README.md`](./examples/README.md) | Step-by-step setup, env vars, and how to run each example. |

---

## Configuration reference

The SDK is configured entirely by constructor arguments and the values you pass at runtime. The canonical list of environment variables used in the examples:

| Variable | Required by | Description |
|---|---|---|
| `GHOSTBROKER_URL` | all | API base URL. Default in examples: `http://localhost:3001`. |
| `GHOSTBROKER_API_KEY` | all | Persistent API key from the dashboard. |
| `AGENT_DID` | admit + intents | Stable DID for this agent. |
| `INSTITUTION_ID` | admit + intents | Institution ID from the dashboard. |
| `POLICY_HASH` | admit | `sha256:…` of the granted policy. |
| `CREDENTIAL_JCS_BASE64` | admit | Base64url Terminal 3 delegation credential. |
| `ADMIN_PRIVATE_KEY` | admit | 32-byte secp256k1 private key, hex, `0x`-prefixed. |
| `AGENT_PRIVATE_KEY` | admit | 32-byte secp256k1 private key, hex, `0x`-prefixed. |
| `ENCRYPTED_INTENT_ENVELOPE` | submit | Produced by the TEE enclave runner; not generated by the SDK. |

See [`.env.example`](./.env.example) for a copy-pasteable template.

---

## Security

- **Treat the API key as a secret.** Anyone with the key can submit intents on behalf of your institution until you revoke it. Store it in a secrets manager (AWS Secrets Manager, HashiCorp Vault, environment-injected secret, etc.). Never commit it. Never log it.
- **The session token is short-lived (8 hours) and lower-privilege than the key** — if leaked, rotate the API key to invalidate all active sessions.
- **The delegation credential + admin private key authorize admission** of an agent. Rotate the admin key if you suspect compromise; rotate the credential from the dashboard.
- **Telemetry events can leak operational metadata** (event types, settlement timing). Treat them as internal.
- For vulnerability reports, see [SECURITY.md](./SECURITY.md).

---

## Support

- **Bug reports & feature requests:** [github.com/zaikaman/GhostBroker/issues](https://github.com/zaikaman/GhostBroker/issues)
- **Discussions & questions:** [github.com/zaikaman/GhostBroker/discussions](https://github.com/zaikaman/GhostBroker/discussions)
- **Docs:** [github.com/zaikaman/GhostBroker/tree/main/docs/agent-integration](https://github.com/zaikaman/GhostBroker/tree/main/docs/agent-integration)
- **Security issues:** see [SECURITY.md](./SECURITY.md) — please do not file public issues for security reports

---

## Contributing

The SDK is part of the [GhostBroker monorepo](https://github.com/zaikaman/GhostBroker). Issues and PRs are welcome on the repo. The SDK has no runtime dependencies beyond `fetch` and `WebSocket`; please don't add any without discussion.

Run the test suite locally:

```bash
npm install
npm run typecheck
npm run build
npm test
```

---

## License

[MIT](./LICENSE) © 2026 GhostBroker

See [CHANGELOG.md](./CHANGELOG.md) for release notes.
