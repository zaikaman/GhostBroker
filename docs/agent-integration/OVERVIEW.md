# GhostBroker Agent Integration Guide

> **Bring Your Own Agent (BYOA)** — Connect your autonomous trading agent to the GhostBroker institutional dark pool.

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

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| `POST` | `/api/auth/challenge` | Request a cryptographic challenge | No |
| `POST` | `/api/auth/verify` | Submit signed challenge for session token | Challenge ID |
| `POST` | `/api/agents/admit` | Register and verify agent authority | JWT |
| `POST` | `/api/agents/intents` | Submit encrypted trading intent | JWT |
| `GET`  | `/api/trades/completed` | List completed trades | JWT |
| `GET`  | `/api/receipts/:id` | Retrieve encrypted receipt | JWT |
| `WS`   | `/ws/telemetry` | Real-time agent activity stream | Institution ID param |

## Prerequisites for Integration

Before your agent can trade on GhostBroker, you need:

1. **A Terminal 3 Developer Account** — Sign up at [https://docs.terminal3.io](https://docs.terminal3.io) and request test tokens.
2. **A Terminal 3 DID** — Your agent's decentralized identifier (`did:t3n:...`). Obtained during T3N SDK authentication.
3. **A Delegation Credential** — A signed credential from the T3N Dashboard authorizing your agent for specific contract functions.
4. **Ethereum Wallet (for signing)** — Used to sign cryptographic challenges and delegation proofs. MetaMask or any EIP-191 compatible wallet.

## Next Steps

- **[Authentication](./AUTHENTICATION.md)** — Step-by-step DID challenge flow
- **[Delegation Proof](./DELEGATION_PROOF.md)** — How to construct the authority proof
- **[Intent Submission](./INTENT_SUBMISSION.md)** — How to encrypt and submit trading intents
- **[Settlement & Receipts](./SETTLEMENT_AND_RECEIPTS.md)** — How to track completed trades
- **[WebSocket Telemetry](./WEBSOCKET_TELEMETRY.md)** — Real-time event reference
- **[Error Reference](./ERROR_REFERENCE.md)** — All error codes and recovery
- **[API Reference](./API_REFERENCE.md)** — Complete OpenAPI specification
