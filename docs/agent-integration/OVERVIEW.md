# GhostBroker Agent Integration Overview

GhostBroker is a **privacy-preserving institutional dark pool** built on confidential computing infrastructure. Unlike traditional exchanges where humans place orders through a UI, GhostBroker operates on an **Agent-to-Agent (A2A)** model:

- **Autonomous agents** — Each institution deploys an AI agent that represents its trading strategy
- **No human intervention** — Humans may only observe via the dashboard. All order placement, matching, and settlement is executed by cryptographically verified agents inside a secure enclave
- **Cryptographically enforced** — The enclave rejects any request that doesn't carry a valid agent identity

## Core Principle: Zero-Human-Interference

GhostBroker is designed for institutions that want autonomous agents to trade directly with each other:

- **Institutions deploy agents**, not traders
- **Agents authenticate with persistent API keys** — no per-request signing
- **Humans watch only** — the Observatory Console is strictly read-only
- **The enclave enforces** — even platform operators cannot view active orders, modify intents, or intervene in matching

This is enforced at the architecture level: the sealed matching core runs inside a hardware-secured enclave that cryptographically verifies every agent action.

## Agent Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Lifecycle                            │
│                                                                 │
│   Sign Up ──► Get Credentials ──► Authenticate ──► Admit ──► Trade   │
│   (Done)        (Dashboard)       (API key)       (Prove)   (Submit Intents) │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Sign Up (Already Complete)
Your institution is already registered on GhostBroker. Your institution ID is shown in the dashboard.

### 2. Get Credentials
Generate an **API key** for your agent from the **API Keys** panel on the dashboard. The key is persistent until you revoke it.

### 3. Authenticate (API key exchange)
Your agent exchanges the API key for an 8-hour session token via `POST /api/auth/api-key`. The SDK does this in one call: `await client.authenticateWithApiKey(GHOSTBROKER_API_KEY)`.

### 4. Admit Agent
The agent is registered with GhostBroker and authorized to submit trading intents. The admit call carries a Ghostbroker-style W3C Verifiable Credential (the credential the live T3N onboarding surface mints); the backend runs it through the Ghostbroker delegation verifier and persists it on the agent record. See [`t3-enclave/src/auth/ghostbroker-delegation.ts`](../../t3-enclave/src/auth/ghostbroker-delegation.ts).

### 5. Submit Intents & Trade
The agent submits encrypted trading intents. The enclave matches compatible intents, executes settlement, and generates encrypted audit receipts.

## Available APIs

All API endpoints are served from your GhostBroker instance base URL.

| Endpoint | Method | Purpose | Human Access? |
|----------|--------|---------|--------------|
| `/api/auth/api-key` | POST | Exchange API key for session | No — agents only |
| `/api/agents/admit` | POST | Register agent for trading | No — agents only |
| `/api/agents/intents` | POST | Submit encrypted trading intent | No — agents only |
| `/api/trades/completed` | GET | Retrieve trade history | Yes — read-only dashboard |
| `/api/receipts/:id` | GET | Retrieve encrypted receipt | Yes — read-only dashboard |
| `WS /ws/telemetry` | WebSocket | Real-time agent activity stream | Yes — read-only dashboard |

> The dashboard uses `/api/auth/challenge` + `/api/auth/verify` for **operator** login. Agents should not call those routes — use `/api/auth/api-key` instead.

Agents interact programmatically. Humans interact through the Observatory Console dashboard.

## What You Need to Connect

1. **A GhostBroker Account** — Already provisioned. Your institution ID is in the dashboard.
2. **An API key** — Generate from the **API Keys** panel on the dashboard. Store it in your agent's secrets manager.
3. **Node.js 20+** (or any language with HTTP + WebSocket) — Runtime for the agent.

## Observatory Console (Dashboard)

The dashboard is strictly **watch-only**. Humans cannot:

- ❌ Submit or cancel orders
- ❌ View other institutions' intents or positions
- ❌ Access the sealed matching core
- ❌ Intervene in active trades

Humans **can**:

- ✅ View agent connection status and telemetry
- ✅ View completed trade history
- ✅ Retrieve encrypted audit receipts
- ✅ Monitor the activity feed

## Next Steps

Follow the [Deploy Your Agent](DEPLOY_YOUR_AGENT.md) guide to get your agent connected, or use the interactive deployment wizard in the dashboard.
