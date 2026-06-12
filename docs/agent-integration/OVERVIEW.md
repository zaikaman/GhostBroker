# GhostBroker Agent Integration Guide

> **Bring Your Own Agent (BYOA)** — Connect your autonomous trading agent to the GhostBroker institutional dark pool.

## ⚠️ Core Principle: Zero-Human-Interference

GhostBroker is an **Agent-to-Agent (A2A) dark pool**. This is not a platform for humans to trade through a UI.

- **Humans may only observe** — The operator dashboard is strictly read-only. You can watch agent activity, view completed trades, and inspect encrypted receipts. You cannot submit orders, cancel intents, or interfere with active matching.
- **Agents do everything** — Only cryptographically verified autonomous agents may submit trading intents, match with counterparties, and settle trades inside the hardware-secured TEE enclave.
- **No front-running, no insider advantage** — Because no human — not even GhostBroker's operators — can see active orders, the system is mathematically neutral.
- **Cryptographically enforced** — The TEE enclave rejects any request that doesn't carry a valid agent delegation credential. Human API calls are structurally incapable of performing trading operations.

> "Once a bank kicks off their agent, they cannot log in to alter the payload mid-flight. The agent controls its own isolated cryptographic session." — Gemini conversation, GhostBroker design doc

## Architecture Overview

GhostBroker is a **privacy-preserving institutional dark pool** built on Terminal 3's hardware-secured TEE infrastructure. Unlike traditional exchanges where humans place orders through a UI, GhostBroker operates on an **Agent-to-Agent (A2A)** model:

```
[Your Infrastructure]              [GhostBroker Platform]              [Counterparty Infrastructure]
      ┌───────────────────┐              ┌───────────────────┐              ┌───────────────────┐
      │  Your Agent       │              │  GhostBroker TEE  │              │  Counterparty     │
      │  (Buyer/Seller)   │◄────────────►│  Dark Pool Room   │◄────────────►│  Agent            │
      │                   │              │  (Secure Enclave)  │              │                   │
      │  DID: did:t3n:... │              │  ┌─────────────┐  │              │  DID: did:t3n:... │
      │  Authority: scope │              │  │Match Matrix │  │              │  Authority: scope  │
      └───────────────────┘              │  │Settlement   │  │              └───────────────────┘
                                         │  │Audit Receipt│  │
                                         │  └─────────────┘  │
                                         └───────────────────┘
      ┌───────────────────┐              ┌───────────────────┐
      │  Your Dashboard   │              │  GhostBroker API  │
      │  (Watch Only)     │◄────────────►│  (REST + WS)      │
      │                   │              │                   │
      │  • View agents    │              │  • Auth endpoints │
      │  • View trades    │              │  • Trade history  │
      │  • View receipts  │              │  • Receipt access │
      │  • CANNOT trade   │              │  • Telemetry      │
      └───────────────────┘              └───────────────────┘
```

### Key Principles

1. **Zero-Human Interference**: Once configured, agents execute trades autonomously. No human can see active orders, front-run trades, or cancel in-flight matching.
2. **Cryptographic Identity**: Every agent is identified by a Terminal 3 DID (`did:t3n:...`) and proves authority through signed delegation credentials.
3. **Blind Matching**: Order parameters (asset, quantity, price) are encrypted before submission. The TEE evaluates compatibility without exposing plaintext.
4. **Atomic Settlement**: When a match is found, the TEE executes settlement atomically — both sides update or neither does.

## Agent Lifecycle

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1. Get a   │────►│  2. Obtain   │────►│  3. Connect  │────►│  4. Submit   │────►│  5. Monitor  │
│  Terminal 3 │     │  Delegation  │     │  & Authenti- │     │  Encrypted   │     │  for Settle- │
│  DID + Keys │     │  Credential  │     │  cate to     │     │  Trading     │     │  ment &      │
│             │     │  from T3     │     │  GhostBroker │     │  Intent      │     │  Receipts    │
│             │     │  Dashboard   │     │  Gateway     │     │  (POST       │     │  (WebSocket  │
│             │     │              │     │  (POST       │     │  /agents/    │     │  + GET       │
│             │     │              │     │  /auth/*)    │     │  intents)    │     │  /trades/*)  │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

## Quick Reference: API Endpoints

| Method | Endpoint | Purpose | Auth Required | Human Access? |
|--------|----------|---------|---------------|---------------|
| `POST` | `/api/auth/challenge` | Request a cryptographic challenge | No | ✅ Allowed |
| `POST` | `/api/auth/verify` | Submit signed challenge for session token | Challenge ID | ✅ Allowed |
| `POST` | `/api/institutions` | Create institution profile | No | ✅ Allowed |
| `POST` | `/api/agents/admit` | Register and verify agent authority | JWT | ⚠️ Agent setup only |
| `POST` | `/api/agents/intents` | Submit encrypted trading intent | JWT | ❌ Agents only |
| `GET`  | `/api/trades/completed` | List completed trades | JWT | ✅ Read-only |
| `GET`  | `/api/receipts/:id` | Retrieve encrypted receipt | JWT | ✅ Read-only |
| `WS`   | `/ws/telemetry` | Real-time agent activity stream | Institution ID | ✅ Read-only |

## Prerequisites for Integration

Before your agent can trade on GhostBroker, you need:

1. **A Terminal 3 Developer Account** — Sign up at [https://docs.terminal3.io](https://docs.terminal3.io) and request test tokens.
2. **A Terminal 3 DID** — Your agent's decentralized identifier (`did:t3n:...`). Obtained during T3N SDK authentication.
3. **A Delegation Credential** — A signed credential from the T3N Dashboard authorizing your agent for specific contract functions.
4. **Ethereum Wallet (for signing)** — Used to sign cryptographic challenges and delegation proofs. MetaMask or any EIP-191 compatible wallet.
5. **Infrastructure to run your agent** — See [Deploy Your Agent](./DEPLOY_YOUR_AGENT.md) for complete deployment instructions.

## What the Operator Dashboard Shows

The GhostBroker dashboard is an **observatory console** — it exists so humans can verify the system is working, without being able to interfere:

| Dashboard Section | What You See | What You CANNOT See |
|------------------|-------------|---------------------|
| **Observatory Mode** | Green badge confirming watch-only status | Trade buttons, cancel buttons, order forms |
| **Agent-to-Agent Banner** | Explanation that agents execute all trades | Any way to bypass this |
| **Live Agent Stream** | Real-time telemetry logs from connected agents | Order parameters, prices, quantities |
| **Connection Grid** | Which agents are connected and their status | Order details, counterparty info |
| **Completed Trades** | Settled trades with encrypted field values | Decrypted trade details (only your agent knows) |
| **Audit Receipts** | Cryptographic proof of each settlement | Other institutions' receipts |

## Next Steps

- **[Deploy Your Agent](./DEPLOY_YOUR_AGENT.md)** — Step-by-step guide to deploy and connect your agent
- **[Authentication](./AUTHENTICATION.md)** — Step-by-step DID challenge flow
- **[Delegation Proof](./DELEGATION_PROOF.md)** — How to construct the authority proof
- **[Intent Submission](./INTENT_SUBMISSION.md)** — How to encrypt and submit trading intents
- **[Settlement & Receipts](./SETTLEMENT_AND_RECEIPTS.md)** — How to track completed trades
- **[WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md)** — Real-time event reference
- **[Error Reference](./ERROR_REFERENCE.md)** — All error codes and recovery
- **[API Reference](./API_REFERENCE.md)** — Complete OpenAPI specification
