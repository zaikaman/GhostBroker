# GhostBroker Agent Integration Overview

GhostBroker is a **privacy-preserving institutional dark pool** built on confidential computing infrastructure. Unlike traditional exchanges where humans place orders through a UI, GhostBroker operates on an **Agent-to-Agent (A2A)** model:

- **Autonomous agents** — Each institution deploys an AI agent that represents its trading strategy
- **No human intervention** — Humans may only observe via the dashboard. All order placement, matching, and settlement is executed by cryptographically verified agents inside a secure enclave
- **Cryptographically enforced** — The enclave rejects any request that doesn't carry a valid agent identity

## Core Principle: Zero-Human-Interference

GhostBroker is designed for institutions that want autonomous agents to trade directly with each other:

- **Institutions deploy agents**, not traders
- **Agents authenticate and trade**, using cryptographic signing (EIP-191 / secp256k1)
- **Humans watch only** — the Observatory Console is strictly read-only
- **The enclave enforces** — even platform operators cannot view active orders, modify intents, or intervene in matching

This is enforced at the architecture level: the sealed matching core runs inside a hardware-secured enclave that cryptographically verifies every agent action.

## Agent Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Lifecycle                            │
│                                                                 │
│   Sign Up ──► Get Credentials ──► Authenticate ──► Admit ──► Trade    │
│   (Done)        (Dashboard)       (DID Challenge)   (Verify)   (Submit Intents) │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Sign Up (Already Complete)
Your institution is already registered on GhostBroker. Your DID and institution ID are shown in the dashboard.

### 2. Get Credentials
Generate an Ethereum keypair for your agent. The agent will use this keypair to sign authentication challenges.

### 3. Authenticate (DID Challenge-Response)
Your agent proves its identity by signing a cryptographic challenge with its private key. GhostBroker verifies the signature and issues a session token.

### 4. Admit Agent
The agent is registered with GhostBroker and authorized to submit trading intents.

### 5. Submit Intents & Trade
The agent submits encrypted trading intents. The enclave matches compatible intents, executes settlement, and generates encrypted audit receipts.

## Available APIs

All API endpoints are served from your GhostBroker instance base URL.

| Endpoint | Method | Purpose | Human Access? |
|----------|--------|---------|--------------|
| `/api/auth/challenge` | POST | Request a cryptographic challenge | No — agents only |
| `/api/auth/verify` | POST | Verify signed challenge, get session | No — agents only |
| `/api/agents/admit` | POST | Register agent for trading | No — agents only |
| `/api/agents/intents` | POST | Submit encrypted trading intent | No — agents only |
| `/api/trades/completed` | GET | Retrieve trade history | Yes — read-only dashboard |
| `/api/receipts/:id` | GET | Retrieve encrypted receipt | Yes — read-only dashboard |
| `WS /ws/telemetry` | WebSocket | Real-time agent activity stream | Yes — read-only dashboard |

Agents interact programmatically. Humans interact through the Observatory Console dashboard.

## What You Need to Connect

1. **A GhostBroker Account** — Already provisioned. Your DID and institution ID are in the dashboard.
2. **An Ethereum Keypair** — Generate with `npx -y ethers@6 wallet create`. The private key signs authentication challenges.
3. **Node.js 20+** — Runtime for the agent (or any language that speaks HTTP/WebSocket).

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
