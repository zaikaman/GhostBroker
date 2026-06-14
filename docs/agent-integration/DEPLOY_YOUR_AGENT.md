# Deploy Your Agent: Connect to GhostBroker

> **This is an Agent-to-Agent platform.** Humans do not place trades, cancel orders, or interact with the dark pool directly. Only cryptographically verified autonomous agents may execute operations inside the secure enclave.

## Architecture Overview

```
[ Your Infrastructure ]                     [ GhostBroker Platform ]

   ┌─────────────────┐                        ┌───────────────────────────────┐
   │ Your Agent       │                        │ GhostBroker Enclave          │
   │ (Buyer/Seller)   │───────────────────────►│                              │
   │                   │  POST /api/auth/      │  ┌─────────────────────┐     │
   │ • API key (gbk_…) │  api-key  → token     │  │ Agent Verification   │     │
   │ • Your strategy   │                       │  │ Blind Order Matching │     │
   │ • Your agentDid   │                       │  │ Atomic Settlement    │     │
   └─────────────────┘                        │  │ Cryptographic Receipt│     │
                                              │  └─────────────────────┘     │
                                              └───────────────────────────────┘

   ┌─────────────────┐                        ┌───────────────────────────────┐
   │ Your Dashboard   │                        │ Observatory Console           │
   │ (Watch Only)     │◄───────────────────────│                              │
   │                   │                        │ • View agent connections     │
   │ • WebSocket       │                        │ • View completed trades      │
   │   telemetry       │                        │ • View encrypted receipts    │
   │ • GET /trades     │                        │ • CANNOT submit/cancel       │
   │ • GET /receipts   │                        └───────────────────────────────┘
   └─────────────────┘
```

## What You Need to Deploy

### 1. Your Agent Software

GhostBroker does not host your agent. You deploy it on your own infrastructure:

- **A cloud VM** (AWS EC2, GCP Compute, Azure VM, or your own secure server)
- **A container** (Docker, Kubernetes pod)
- **Your agent can be written in any language** that supports HTTP and WebSocket connections

The agent SDK is `@ghostbroker/agent-client` (TypeScript/Node). For other languages, use plain HTTP — the contract is just `POST /api/auth/api-key` plus a `Bearer` token on every other call.

### 2. Required Components

| Component | Description | How to Get It |
|-----------|-------------|---------------|
| **GhostBroker Account** | Platform access with your institution | Sign in to the dashboard once to provision it |
| **API key** (`gbk_…`) | Persistent credential for your agent | Generate from the **API Keys** panel on the dashboard |
| **Agent DID** | Stable identifier the platform uses for your agent | Set it yourself (e.g. `did:t3n:0xYourAgentAddress`); referenced in admission |

> No more private-key signing on every login. The API key is what your agent uses from now on.

### 3. Runtime Dependencies

If you're using the SDK: none beyond the package itself. The SDK uses native `fetch` and `WebSocket`.

If you're not using the SDK: you only need a JSON HTTP client and a WebSocket client. No cryptographic libraries are required for auth.

## Deployment Steps

### Step 1: Provision Your Agent Infrastructure

Choose your deployment target and ensure it has:

- Node.js 20+ runtime (if using TypeScript/JS) or any language with HTTP + WebSocket
- Outbound internet access to GhostBroker's API endpoint
- Secure storage for your API key (env var, secrets manager, or mounted secret)

### Step 2: Set Up Environment Variables

```bash
# GhostBroker connection
GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com
GHOSTBROKER_API_KEY=***  # The credential from the dashboard API Keys panel

# Your agent identity
AGENT_DID=did:t3n:0xYourAgentAddress
INSTITUTION_ID=uuid-here  # From the dashboard
```

### Step 3: Write Your Agent

Use the SDK to get auth + telemetry in one call:

```typescript
import { GhostBrokerClient } from "@ghostbroker/agent-client";

const client = new GhostBrokerClient({ baseUrl: process.env.GHOSTBROKER_URL! });

// One call: exchanges the API key for an 8-hour session and wires
// the institution ID into the telemetry WebSocket filter.
const session = await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);
console.log(`✅ Authenticated as ${session.institution.displayName}`);

// Admit your agent
const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  authorityProof: process.env.AUTHORITY_PROOF!,
});
console.log(`Authority: ${admission.authorityRef}`);

// Listen for settlement events
client.telemetry.onSettled((ref) => console.log("🎯 Trade settled:", ref));
client.telemetry.connect();

// Submit intents via client.submitIntent(...)
```

### Step 4: Deploy and Run

```bash
# Run locally first to verify
npx tsx your-agent.ts

# Deploy to production (example: Docker)
docker build -t my-ghostbroker-agent .
docker run -d \
  -e GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com \
  -e GHOSTBROKER_API_KEY=*** my-ghostbroker-agent
```

### Step 5: Monitor via the Dashboard

Once your agent is connected, open the GhostBroker Observatory Console dashboard:

1. Navigate to the dashboard URL
2. Sign in with your Web3 wallet (this is the operator login — separate from agent auth)
3. You will see:
   - **Observatory Mode badge** — confirms you are in watch-only mode
   - **Agent-to-Agent banner** — reinforces the no-human-interference policy
   - **Live Agent Activity Stream** — real-time logs from your agent
   - **Agent Connection Grid** — shows all connected agents
   - **Completed Trades Table** — appears after settlement
   - **Encrypted Receipts** — cryptographic proof of each trade

## What Your Agent CAN and CANNOT Do

### ✅ Agent CAN
- Authenticate with a persistent API key
- Submit encrypted trading intents
- Receive settlement notifications via WebSocket
- Retrieve completed trade history
- Retrieve encrypted audit receipts
- Run its own proprietary trading strategy

### ❌ Agent CANNOT
- See other agents' orders, prices, or quantities
- Cancel another agent's intents
- Access the secure enclave's internal state
- Decrypt other institutions' receipts

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `validation_failed` on `/api/auth/api-key` | Missing or empty `apiKey` in body | Ensure the body is `{"apiKey":"gbk_…"}` and the key is non-empty |
| `authorization_failed` on `/api/auth/api-key` | Unknown, revoked, or malformed key | Generate a new key from the dashboard API Keys panel |
| Token rejected mid-session | Session token expired (8h TTL) | Re-run `client.authenticateWithApiKey()` with the same key |
| `service_unavailable` | Platform issue | Check GhostBroker status |
| WebSocket won't connect | Missing or invalid institution ID | Always call `authenticateWithApiKey()` first, or pass `institutionId` in the config |
| No settlement after hours | No compatible counterparty order | Add more agents or adjust pricing |
| Dashboard shows no agents | Agent hasn't completed auth flow | Check agent logs for errors |

## See also

- [Authentication](./AUTHENTICATION.md) — full auth contract, session lifecycle, troubleshooting
- [Delegation Proof](./DELEGATION_PROOF.md) — how to construct the `authorityProof` blob for `admitAgent`
- [API Reference](./API_REFERENCE.md) — every endpoint, request shape, and response
