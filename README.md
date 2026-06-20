# GhostBroker

**Institutional Dark Pool with Verifiable Agent Authority**

GhostBroker is a production-grade institutional dark pool platform where autonomous
trading agents submit buy and sell intents that are matched and settled without any
counterparty ever seeing another counterparty's parameters. Active order data lives
exclusively inside the Terminal 3 Trusted Execution Environment; the dashboard, the
API, the database, and the WebSocket telemetry stream see only opaque handles,
sanitized state labels, and completed trade records. Agents are admitted and
authorized via Ghostbroker-style W3C Verifiable Credentials, re-verified on every
privileged action. Humans operate a read-only Observatory Console to monitor
connectivity and review completed history with encrypted audit receipts.

Built for the **Terminal 3 Agent Dev Kit Bounty** (June 9--22, 2026).

---

## Table of Contents

1.  [Architecture Overview](#architecture-overview)
2.  [Repository Structure](#repository-structure)
3.  [Technology Stack](#technology-stack)
4.  [Terminal 3 Agent Auth SDK Integration](#terminal-3-agent-auth-sdk-integration)
5.  [Two-Tier Authentication Architecture](#two-tier-authentication-architecture)
6.  [Privacy Boundary](#privacy-boundary)
7.  [Negotiation Engine](#negotiation-engine)
8.  [Settlement Rails](#settlement-rails)
9.  [TEE Smart Contracts](#tee-smart-contracts)
10. [Agent Client SDK](#agent-client-sdk)
11. [Hosted LLM Agents](#hosted-llm-agents)
12. [Observatory Console (Frontend)](#observatory-console-frontend)
13. [Database Schema](#database-schema)
14. [API Reference](#api-reference)
15. [Getting Started](#getting-started)
16. [Environment Configuration](#environment-configuration)
17. [Running the Platform](#running-the-platform)
18. [Testing](#testing)
19. [Deployment](#deployment)
20. [Terminal 3 ADK Onboarding Gaps Filed](#terminal-3-adk-onboarding-gaps-filed)
21. [License](#license)

---

## Architecture Overview

GhostBroker is organized as an npm workspaces monorepo with two primary workspaces
and several internal modules that together form a six-layer architecture:

```
                                  Observatory Console
                                   (React + Vite)
                                        |
                                        | REST + WebSocket
                                        v
                              +--------------------+
                              |   Express Backend   |
                              |   (Heroku target)   |
                              +--------------------+
                             /    |       |        \
                            /     |       |         \
                     +------+ +--------+ +-------+ +----------+
                     | Auth | | Negot. | | Match | | Settlem. |
                     | Gate | | Orch.  | | Orch. | | Service  |
                     +------+ +--------+ +-------+ +----------+
                        |         |          |           |
                        v         v          v           v
                  +------------------------------------------+
                  |         T3 Enclave Boundary               |
                  |  (DID Registry, VC Verifier, Blind Intent |
                  |   Client, Match Contract, Negotiation     |
                  |   Ticket, Settlement Command Builder)     |
                  +------------------------------------------+
                                     |
                              +------+------+
                              |  Supabase   |
                              | (Postgres)  |
                              +-------------+
```

The architecture enforces a hard privacy boundary: active hidden intent parameters
(asset, side, quantity, price, counterparty, queue rank, match score) never cross
the enclave boundary into REST responses, WebSocket events, database rows, or
server logs.

---

## Repository Structure

```
ghostbroker/
|
|-- frontend/                          Vite + React Observatory Console
|   |-- src/
|   |   |-- app/                       App shell, routing, main layout
|   |   |-- components/                25 production UI components
|   |   |-- hooks/                     Real-time telemetry and data hooks
|   |   |-- services/                  API client, telemetry, wallet auth
|   |   |-- styles/                    Design system CSS (theme, dashboard, landing)
|   |   +-- test/                      17 frontend test files (71 tests)
|   |-- public/                        Static assets
|   +-- package.json                   @ghostbroker/frontend workspace
|
|-- backend/                           Express + WebSocket API
|   |-- src/
|   |   |-- api/                       13 route modules (REST endpoints)
|   |   |-- auth/                      Agent authorization facade, operator auth,
|   |   |                              API key auth, session tokens
|   |   |-- cli/                       Agent CLIs (buyer, seller, hosted, identity,
|   |   |                              delegation, LLM providers, negotiation loop)
|   |   |-- config/                    Environment loader and validation
|   |   |-- enclave/                   Terminal 3 ADK boundary layer
|   |   |   |-- auth/                  Ghostbroker delegation VC verifier,
|   |   |   |                          agent identity, DID registry, authority claims
|   |   |   |-- keys/                  Key generation, rotation, sealed secret maps
|   |   |   |-- matching/              Blind intent client, match contract client,
|   |   |   |                          settlement command builder
|   |   |   |-- negotiation/           Ticket client, round evaluator,
|   |   |   |                          disclosure verifier
|   |   |   |-- runner/                Enclave agent loop runner and lifecycle
|   |   |   |-- sandbox/               T3N client, config, token balance,
|   |   |   |                          tenant identity store
|   |   |   +-- settlement/            Settlement execution via enclave
|   |   |-- errors/                    Typed public error system
|   |   |-- logging/                   Pino logger with forbidden-field redaction
|   |   |-- middleware/                Correlation ID injection
|   |   |-- models/                    TypeScript domain models
|   |   |-- negotiation-core/          Shared strategy math, turn context,
|   |   |                              decision validation (27 tests)
|   |   |-- privacy/                   Forbidden-field scanner and assertions
|   |   |-- sdk/
|   |   |   +-- agent-client/          Published Node.js SDK for external agents
|   |   |                              (21 files, 56 tests)
|   |   |-- services/                  29 service modules + settlement-rails/
|   |   |-- tests/                     57 backend test files (194 tests)
|   |   |-- validation/               Zod request schemas
|   |   +-- websocket/                 Telemetry server, event types, redaction
|   |-- contracts/
|   |   |-- matching-policy/           Rust WASI P2 TEE contract (seal + match)
|   |   +-- relayer/                   Solidity settlement relayer (Foundry)
|   +-- package.json                   @ghostbroker/backend workspace
|
|-- database/
|   |-- schema.sql                     Supabase schema (13 tables, RLS)
|   |-- migrations/                    Incremental Supabase migrations
|   |-- policies/                      Row-level security policies
|   |-- functions/                     Database functions
|   +-- seed/                          Development seed data
|
|-- tests/                             Playwright E2E test configuration
|-- scripts/                           Build, publish, and verification scripts
|-- DESIGN.md                          Design system specification
|-- PRODUCT.md                         Product brief and brand personality
|-- terminal3-adk-onboarding-doc-gaps.md  T3 ADK onboarding gaps filed
+-- package.json                       Root workspace orchestrator
```

---

## Technology Stack

### Backend

| Layer              | Technology                                      |
| ------------------ | ----------------------------------------------- |
| Runtime            | Node.js >= 20.19, TypeScript 6.0                |
| HTTP Framework     | Express 5.2                                     |
| WebSocket          | ws 8.21                                         |
| Database           | Supabase (PostgreSQL) via @supabase/supabase-js  |
| Terminal 3 SDK     | @terminal3/t3n-sdk 3.5, @terminal3/verify_vc 0.0.38 |
| Cryptography       | @noble/curves 2.2, @noble/hashes 1.5, ethers    |
| Blockchain         | viem 2.52 (Sepolia ERC-20 settlement)           |
| Validation         | Zod 4.4                                         |
| Logging            | Pino 10.3                                       |
| Security           | Helmet 8.2, CORS                                |
| Smart Contracts    | Rust (WASI P2, wit-bindgen), Solidity (Foundry)  |
| Testing            | Vitest 4.1, Supertest 7.2                       |

### Frontend

| Layer              | Technology                                      |
| ------------------ | ----------------------------------------------- |
| Framework          | React 19.2, Vite 8.0                            |
| 3D Rendering       | Three.js 0.184 (SecureCore3D enclave viz)       |
| Video Streaming    | hls.js 1.6 (attested enclave canvas)            |
| Icons              | hugeicons-react 0.4, lucide-react 1.18          |
| Testing            | Vitest 4.1, Testing Library, Playwright 1.60    |
| Typography         | Cinzel (display), Plus Jakarta Sans (body),     |
|                    | Share Tech Mono (crypto data), Instrument Serif |

### Infrastructure

| Concern            | Provider                                        |
| ------------------ | ----------------------------------------------- |
| Frontend Hosting   | Vercel                                          |
| Backend Hosting    | Heroku                                          |
| Database           | Supabase (managed PostgreSQL + RLS)             |
| TEE                | Terminal 3 Network (hardware-secured enclaves)  |
| Settlement Chain   | Ethereum Sepolia (ERC-20 atomic settlement)     |
| LLM Providers      | Gemini, OpenAI, Groq (multi-provider fallback)  |

---

## Terminal 3 Agent Auth SDK Integration

The Terminal 3 Agent Auth SDK is load-bearing infrastructure in GhostBroker, not
a cosmetic wrapper. Every privileged backend action passes through the same
`T3AgentAuthorizationFacade`, which delegates to the Ghostbroker-style W3C
Verifiable Credential verifier at
`backend/src/enclave/auth/ghostbroker-delegation.ts`.

### Verification Pipeline

The verifier performs the following checks on every credential, in order:

1. **Shape validation** -- Zod schema parse (`ghostbrokerDelegationSchema`)
   enforces `id`, `issuer`, `credentialSubject.agentDid`,
   `credentialSubject.allowedActions`, `issuanceDate`, `expirationDate`, and
   `proof` object presence.

2. **Time-window enforcement** -- The credential's `issuanceDate` and
   `expirationDate` are validated against the current server time. Expired
   credentials are rejected with reason `expired`.

3. **DID binding** -- The credential's `credentialSubject.agentDid` must
   exactly match the agent DID on the incoming request. A mismatch yields
   `agent_mismatch`.

4. **Revocation check** -- The verifier accepts a `revokedAuthorityRefs` set
   sourced from `AuthorityRevocationRepository` before every check. Revoked
   references are rejected with reason `revoked`. Revocation reasons include
   `operator_revoked`, `policy_replaced`, `credential_compromised`, and
   `terminal3_revoked`.

5. **Cryptographic verification** (live mode) -- The verifier implements
   inline ECDSA verification: strip the proof from the VC, `keccak256` the
   JSON payload, recover the signer address via `ethers.verifyMessage`, and
   assert the recovered address matches one of the trusted signer addresses
   (issuer DID address or additional trusted addresses from the composition
   root). The verifier fails closed on any exception -- it never silently
   downgrades to a non-cryptographic pass.

6. **Authority reference** -- Every successful verification produces a
   `ghostbroker-delegation:<vc-id>` reference. The agent must echo this on
   every privileged action, and the backend re-asserts equality on each call.

7. **Policy hash** -- A stable SHA-256 hex fingerprint derived from the
   canonicalized credential, suitable for equality checks, database indexing,
   and UI display.

### Verification Mode

The verifier runs in exactly one mode — `live` — hard-coded at
`backend/src/enclave/auth/ghostbroker-delegation.ts`. On every call the verifier:

1. parses the VC against `ghostbrokerDelegationSchema`,
2. checks the time window (`issuanceDate` ≤ now ≤ `expirationDate`),
3. checks the DID binding (`credentialSubject.agentDid` matches the
   requesting agent),
4. checks revocation (`authorityRef` not in `revokedAuthorityRefs`),
5. cryptographically verifies the `EcdsaSecp256k1Signature2019` proof
   inline (`keccak256(canonicalJson)` → `ethers.verifyMessage` →
   recovered address matched against the issuer DID's address and the
   caller's `additionalTrustedSignerAddresses` set),
6. fails closed on any exception — never silently downgrades to a
   non-cryptographic pass.

The `setup:identity` + `setup:delegation` flow (and the server-side
`tenant-delegation.ts` signer) produce a real signed JWS by default,
so the verifier's `live` mode is the production gate on every
privileged action (`agent.admit`, `intent.submit`, `settlement.execute`,
`negotiation.*`).

### Privileged Actions Protected

The following actions require a verified delegation credential on every call:

- `agent.admit` -- Initial agent admission (inline VC)
- `intent.submit` -- Hidden intent submission to the matching engine
- `intent.cancel` -- Intent cancellation
- `settlement.execute` -- Trade settlement execution
- `negotiation.open` -- Negotiation ticket sealing
- `negotiation.move` -- Negotiation round moves (propose, counter, accept, hold, walkaway)
- `negotiation.disclose` -- Selective claim disclosure
- `negotiation.settle` -- Negotiation-based settlement

### Server-Side VC Persistence

In the post-Phase 1 architecture, agents do not send the VC on every call.
The backend owns the persisted credential:

1. At admission, the dashboard mints and signs the VC via the
   `BackendTenantDelegationSigner`.
2. The VC is persisted on the `agents` database row.
3. On every subsequent privileged call, the `T3AgentAuthorizationFacade`
   calls `loadAndVerify`, which looks up the persisted VC from the agent
   record and runs the full verification pipeline.
4. The same `verifyGhostbrokerDelegationCredential` function is the only
   verifier behind both the admit-time and per-action paths.

---

## Two-Tier Authentication Architecture

GhostBroker implements a layered authentication model that matches the Terminal 3
Agent Auth SDK's design intent:

| Layer         | Credential                              | Consumer                        | Purpose                                    |
| ------------- | --------------------------------------- | ------------------------------- | ------------------------------------------ |
| **Session**   | `gbk_...` persistent API key exchanged for an 8-hour JWT | External agent SDK + hosted negotiator | Authenticate the agent to the backend across reconnects and restarts |
| **Authority** | Ghostbroker delegation W3C Verifiable Credential | Every privileged action via `loadAndVerify` | Authorize this specific action against institution policy |

### Session Layer

- API keys are minted per institution via `POST /api/api-keys` and stored in
  the `api_keys` table as:
  - `key_bcrypt` — `bcrypt(token, cost=12)` of the full key. Constant-time
    verified at request time via `bcrypt.compare`. Plaintext cannot be
    recovered within the threat model.
  - `lookup_key` — `HMAC-SHA256(AUTH_SESSION_SECRET, token)`, hex. Unique,
    indexed, the equality lookup key on every request. Keyed by the same
    server secret that signs operator session JWTs, so a database breach
    alone is insufficient to enumerate valid tokens.
- Agents exchange the key at `POST /api/auth/api-key` for an 8-hour JWT.
- The JWT identifies the institution; the backend looks up the agent and its
  persisted VC from there.
- Revocation is immediate: revoking the API key invalidates all sessions.

### Authority Layer

- The delegation VC answers: "Is this agent authorized to do this right now,
  for this action, against this policy?"
- The VC carries `allowedActions` (the same `RequestedAgentAction` enum the
  orchestrator enforces), `maxSpendUsd`, `agentDid`, and time bounds.
- Authority revocation is tracked in `agent_authority_revocations` with four
  typed reasons and an optional `unrevoked_at` for reinstatement.

### Operator Authentication

For human operators, the dashboard uses a Terminal 3 DID challenge-response
flow:

1. `GET /api/auth/challenge` -- Backend issues a nonce-bound challenge.
2. The operator signs the challenge with their wallet (secp256k1).
3. `POST /api/auth/verify` -- Backend verifies the signature via
   `T3AgentIdentityVerifier` and issues a session JWT.

---

## Privacy Boundary

Active hidden intent parameters never appear in any external surface. The privacy
boundary is enforced at three independent layers:

### Layer 1: API Schema Enforcement

The Zod schema at `POST /api/agents/intents` rejects any request containing
plaintext `asset`, `side`, `quantity`, or `price` fields with
`validation_failed` before the request reaches the orchestrator. Intent
submission accepts only opaque encrypted payloads.

### Layer 2: WebSocket Telemetry Redaction

The `redact-event.ts` module enforces an explicit allowlist of fields that may
appear on WebSocket telemetry events:

- `eventId`, `institutionId`, `type`, `phase`, `severity`, `timestamp`
- `correlationRef`, `agentId`, `receiptRef`, `railProofRef`, `latencyMs`

Any event payload carrying forbidden fields (asset, side, quantity, price,
counterparty, queue rank, match score) is caught by `scanForbiddenFields`
and rejected. The redaction layer is unit-tested against every field on the
deny list.

### Layer 3: Database Schema

The `completed_trades` table stores settlement data exclusively as ciphertext:

- `asset_code_ciphertext` -- Encrypted asset identifier
- `quantity_ciphertext` -- Encrypted trade quantity
- `execution_price_ciphertext` -- Encrypted execution price

All three columns have `CHECK (column <> '')` constraints. The corresponding
plaintext values never cross the Supabase boundary. What an operator sees in
the Observatory Console:

- Connection status (backend, WebSocket, Supabase, T3 sandbox, per-agent)
- Sanitized state transitions: `agent_verified`, `intent_sealed`,
  `encrypted_evaluation`, `settlement_finalized`, `receipt_available`
- Completed trade records (post-settlement only, encrypted fields)
- Audit receipt metadata (hash, key version, attestation reference)

---

## Negotiation Engine

GhostBroker ships a turn-based bilateral negotiation engine where LLM-powered
agents negotiate within verifiable authority rails. The negotiation is not
free-form LLM-vs-LLM chat; the orchestrator owns the structural constraints
while the LLM owns the strategy.

### State Machine

```
pairing --> active --> converged --> settling --> settled
                  \--> walked_away
                  \--> expired
                  \--> awaiting_approval (escalation gate)
```

### Orchestrator Architecture

The `NegotiationOrchestrator` (1,968 lines) manages the full session lifecycle:

1. **Ticket Sealing** -- Each agent seals a negotiation ticket through the
   TEE (`T3NegotiationTicketClient`). The TEE binds the agent's DID,
   institution, asset, side, and compatibility token into an opaque handle.

2. **Compatibility-Aware Pairing** -- The orchestrator finds compatible
   waiting tickets using policy-aware matching: same asset, opposite side,
   different institution, overlapping size regime, and claim compatibility.
   The TEE is the structural authority on pair validity via `verifyPair`.

3. **Turn-Based Moves** -- Each round, the active agent submits a bounded
   move. Move types include:
   - `propose` / `counter` -- Price and quantity proposals
   - `reveal` -- Selective claim disclosure (TEE-verified)
   - `request_disclosure` -- Request counterparty claims
   - `accept` -- Accept current terms
   - `hold` -- Pass without advancing
   - `walkaway` -- Terminate the negotiation

4. **Price Validation** -- Every priced move is validated against the
   `negotiation-core` shared strategy math: price within the mandate's
   derived price band, quantity within target bounds, notional under ceiling.
   The same validator runs on both the backend (authoritative) and the agent
   runtime (pre-clamp to avoid burning rounds).

5. **Disclosure Gate** -- Convergence requires the disclosure gate to be
   satisfied in addition to a price cross. The gate tracks which claims
   each side has disclosed and whether reciprocity requirements are met.

6. **Escalation** -- Agents can request operator approval when the
   negotiation reaches terms outside their autonomous authority. The session
   enters `awaiting_approval` and a timer auto-expires it at the deadline.

7. **Settlement** -- On convergence, the orchestrator calls the settlement
   service with the agreed terms, the TEE-snapshotted delegation
   credentials, and the enclave's settlement command.

### Mandate Configuration

Each agent operates under a negotiation mandate that defines its authority
envelope. The mandate carries both operator-authored policy and derived
numeric rails:

- **Objective** -- Free-text negotiation goal
- **Execution style** -- `patient`, `balanced`, `aggressive`,
  `relationship_first`, or `trust_first`
- **Valuation policy** -- Anchor value, source, and operator notes
- **Concession policy** -- Pace and max concession in basis points
- **Disclosure policy** -- Allowed claim ladder and reciprocity requirements
- **Approval policy** -- `auto_settle` or `require_operator_approval`
- **Counterparty requirements** -- Required claims, disallowed traits,
  reputation tier
- **Size policy** -- Target quantity, minimum quantity, partial execution
- **Time window** -- Deadline and preferred trading window

The `negotiation-core` module (41,729 bytes, 27 tests) provides the shared
strategy math consumed by both the backend orchestrator and the hosted agent
runtime: `normalizeStrategy`, `buildTurnContext`, `derivedPriceBandFor`,
`disclosureGateSatisfied`, `preferredEnvelopeFor`, `validateAgentDecision`,
and `pairingCompatibility`.

---

## Settlement Rails

GhostBroker ships a pluggable settlement rail layer that moves assets when a
match settles. The layer is defined in `backend/src/services/settlement-rails/`.

### Rail Registry

| Rail ID                | Type    | Description                           |
| ---------------------- | ------- | ------------------------------------- |
| `chain:sepolia:erc20`  | On-chain | Real `GhostBrokerSettlementRelayer` Solidity contract. Atomic ERC-20 settlement on Ethereum Sepolia. GhostBroker's only settlement rail — required at boot time. |

### Settlement Flow

1. The `SettlementService` receives a settlement execution request from either
   the matching orchestrator or the negotiation orchestrator.
2. The `SettlementCommandBuilder` (in the enclave boundary) re-verifies the
   agent's delegation VC for `settlement.execute`.
3. The `MapSettlementRailDispatcher` selects the rail based on the
   institution's `settlement_profile_ref`. GhostBroker exposes a single rail
   (`chain:sepolia:erc20`); any other profile fails closed with
   `RailDispatchError`.
4. The selected rail executes the atomic settlement by broadcasting
   `settle(...)` on the relayer contract, waiting for confirmation,
   decoding the `Settled` event, and writing the row with the chain tx hash.
5. Portfolio balances are updated atomically via `PortfolioService`.
6. Audit receipts are generated with encrypted payloads and T3 attestation
   references.
7. Telemetry events are published for operator visibility.

### On-Chain Settlement Details

The `SepoliaErc20Rail` uses the `GhostBrokerSettlementRelayer` Solidity contract
deployed via Foundry. The contract holds per-institution pre-approved ERC-20
allowances and broadcasts the atomic `settle(...)` call:

```
settle(bytes32 tradeRef, bytes32 executionRef,
       address buyDeposit, address sellDeposit,
       address buyToken, address sellToken,
       uint256 buyAmount, uint256 sellAmount)
```

The chain rail preserves the dark-pool privacy claim end-to-end: a public chain
observer sees the institution deposit addresses and amounts but not the
TEE-decrypted quantity-times-price semantics.

### Relayer Signer Architecture

The relayer signer is a deliberate seam for the TEE production swap:

- **v1 demo**: A `ViemWalletRelayerSigner` signs with the environment
  variable private key.
- **Production**: A `TeeAttestedRelayerSigner` whose tenant private key is
  held inside the T3 tenant TEE. The on-chain `from` is the tenant
  identity's address; in production the key extraction is
  attestation-anchored.

### Settlement Reconciler

The `SettlementReconciler` is a system task that periodically polls
`completed_trades` for unreconciled rows and verifies the chain state via
`rail.status(railTradeRef)`. Drift is surfaced via a `rail_drift_detected`
telemetry event. The admin reverser endpoint
(`POST /api/admin/trades/:tradeRef/reverse`) is the only path that can flip
a settled row's `settlement_status`.

---

## TEE Smart Contracts

GhostBroker deploys two categories of smart contracts that run inside the
Terminal 3 enclave surface:

### Matching Policy Contract (Rust / WASI P2)

Located at `backend/contracts/matching-policy/`, this Rust crate compiles to
a WASI Preview 2 component and runs inside the T3N TEE. It exposes two
operations:

**`seal-intent`** -- Mints:
- `intent_handle` -- `intent_<32 hex>` = SHA-256 of
  `institution_id|agent_did|encrypted_intent|authority_ref|correlation_ref`.
  Deterministic, so the orchestrator can deduplicate accidental re-seals.
- `execution_ref` -- `t3exec_<32 hex>` from a fresh monotonic counter.

**`evaluate-match`** -- Mints:
- `outcome_ref` -- `outcome_<32 hex>` = SHA-256 of
  `buy_intent_handle|sell_intent_handle|correlation_ref`.
- `encrypted_trade_fields_ref` -- `t3fields_<32 hex>` = SHA-256 of
  `buy_intent_handle:sell_intent_handle`.
- `status` -- `"matched"` when `buy_price >= sell_price` and all fields are
  valid positive integers; `"no_match"` otherwise.
- `matched_quantity` -- `min(buy_quantity, sell_quantity)` (decimal string).
- `execution_price` -- Deterministic midpoint `(buy_price + sell_price) / 2`
  rounded half-up (decimal string).

The backend orchestrator is a verifier around the enclave outcome: it filters
obvious non-candidates locally, then trusts the enclave's decision and the
returned `matched_quantity` / `execution_price` for settlement. It never
recomputes the crossing locally.

### Settlement Relayer Contract (Solidity / Foundry)

Located at `backend/contracts/relayer/`, this Foundry project contains the
`GhostBrokerSettlementRelayer.sol` contract and `MinimalERC20.sol` for
testing. The relayer is deployed to Ethereum Sepolia and handles the atomic
ERC-20 token transfers that finalize a matched trade.

---

## Agent Client SDK

The `@ghostbroker/agent-client` SDK (21 files, 56 tests) at
`backend/src/sdk/agent-client/` is the published Node.js TypeScript SDK
consumed by external agents and the hosted negotiator. It provides a
complete client for every GhostBroker API surface:

### SDK Modules

| Module                  | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `GhostBrokerClient`     | Top-level facade orchestrating all sub-clients  |
| `DelegationSigner`      | Signs Ghostbroker delegation W3C VCs with EcdsaSecp256k1Signature2019 |
| `AuthClient`            | API key exchange, JWT management, session refresh |
| `IntentClient`          | Hidden intent submission and cancellation        |
| `NegotiationClient`     | Mandate creation, ticket submission, move submission |
| `PortfolioClient`       | Portfolio balance queries and history            |
| `TradesClient`          | Completed trade history retrieval                |
| `ReceiptClient`         | Encrypted audit receipt access                   |
| `WebSocketClient`       | Real-time telemetry stream subscription          |

### Type System

The SDK exports a comprehensive type system in `types.ts` (8,296 bytes)
covering all request/response shapes, telemetry events, negotiation moves,
settlement status enums, and error codes.

---

## Hosted LLM Agents

GhostBroker includes a hosted multi-provider LLM agent system at
`backend/src/cli/agents/` that demonstrates the full agent lifecycle
within the mandate rail:

### Multi-Provider LLM Chain

The agent runtime uses a priority-ordered fallback chain across three LLM
providers:

| Priority | Provider | Model (configurable)      |
| -------- | -------- | ------------------------- |
| 1        | Gemini   | gemini-3.1-flash-lite     |
| 2        | OpenAI   | gpt-5-nano                |
| 3        | Groq     | qwen/qwen3-32b           |

Each provider client (`gemini-client.ts`, `openai-client.ts`,
`groq-client.ts`) implements a common interface. The `fallback-chain.ts`
module tries each provider in order, falling back on HTTP errors or
malformed responses.

### Agent Lifecycle

1. **Identity Setup** -- `identity.ts` loads or creates a secp256k1 keypair
   and derives a `did:t3n:0x<address>` agent DID.
2. **Delegation Claim** -- `claim-credential.ts` requests a signed
   delegation VC from the backend.
3. **Admission** -- The agent presents its VC to `POST /api/agents/admit`.
4. **Settlement Pre-Clear** -- `assertSettlementReady()` verifies the
   institution's deposit balance before the negotiation loop starts.
5. **Negotiation Loop** -- `negotiation-loop.ts` (29,480 bytes) runs the
   turn-based negotiation. Each turn:
   - Builds a `TurnContext` from the session state and mandate
   - Calls the LLM with the context and strategy profile
   - Validates the LLM's decision against the mandate rails
   - Submits the bounded move to the backend
6. **Settlement** -- On convergence, the orchestrator settles automatically.

### LLM Decision Validation

The `negotiation-decision.ts` module (30,798 bytes, tested by 23,854 bytes
of tests) validates every LLM decision before submission:

- Price must be within the derived price band
- Quantity must not exceed the mandate target
- Notional (price times quantity) must not exceed the ceiling
- The decision must include reasoning and confidence
- Strategic intent must be a recognized enum value

---

## Observatory Console (Frontend)

The frontend is a Vite + React 19 Observatory Console deployed to Vercel. It
provides a read-only institutional monitoring interface designed around the
principle of Zero Visibility Integrity: operators can observe system state
and audit completed transactions, but active trading data remains hidden
behind the TEE boundary.

### Design System

The interface follows the "Attested Enclave" design language documented in
`DESIGN.md`:

- **Color palette**: Deep black-tint (`#070b0a`) background with Enclave
  Emerald (`#5ed29c`) accents restricted to cryptographic attestation
  status. The Rarity Rule: emerald never exceeds 10% of visible surface.
- **Typography**: Cinzel (display), Plus Jakarta Sans (body), Share Tech
  Mono (cryptographic data), Instrument Serif (highlights).
- **Components**: Glassmorphic cards with `backdrop-filter: blur(12px)`,
  double-mask composited borders, pill-shaped buttons.

### Component Inventory (25 components)

| Component                    | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `LandingPage`                | HUD-style entry with SecureCore3D enclave visualization |
| `AuthGateway`                | DID challenge-response wallet authentication |
| `AgentsPanel`                | Agent status monitoring and management      |
| `AgentConnectionGrid`        | Per-agent connectivity status grid          |
| `AgentDeploymentGuide`       | Interactive 8-step agent deployment walkthrough |
| `AgentProvisioningForm`      | Agent creation and configuration            |
| `AgentLogEntry`              | Individual agent activity log entries       |
| `MandateConfigForm`          | Negotiation mandate policy editor           |
| `NegotiationRoomPanel`       | Live negotiation session monitoring         |
| `TeeNegotiationVisualizer`   | Real-time TEE negotiation pipeline visualization |
| `LiveAgentActivityStream`    | Streaming agent activity timeline           |
| `CompletedTradesTable`       | Settlement history with encrypted fields    |
| `EncryptedReceiptDrawer`     | Audit receipt viewer with decryption        |
| `PortfolioCard`              | Per-institution portfolio balances          |
| `PortfolioHistory`           | Historical balance changes and movements    |
| `SettlementProfileCard`      | Settlement rail configuration display       |
| `DepositWalletOverviewCard`  | Chain deposit wallet status and balances    |
| `EnclaveHealthMonitor`       | TEE health and connectivity dashboard       |
| `ProcessingStatusRail`       | Multi-phase processing status indicator     |
| `SecureCore3D`               | Three.js 3D enclave visualization           |
| `SecureMetric`               | Single secure metric display                |
| `SettingsPanel`              | Operator settings and configuration         |
| `DisclosureTimeline`         | Negotiation disclosure history timeline     |
| `Pagination`                 | Paginated data navigation                   |
| `Skeleton`                   | Consistent skeleton loading states          |

### Frontend Services

| Service               | Purpose                                         |
| --------------------- | ----------------------------------------------- |
| `api-client.ts`       | Full REST API client (27,213 bytes)              |
| `telemetry-client.ts` | WebSocket telemetry stream consumer              |
| `telemetry-labels.ts` | Human-readable telemetry phase labels            |
| `wallet-auth.ts`      | Wallet-based DID authentication                  |
| `wallet-deposit.ts`   | Chain deposit wallet utilities                   |
| `agent-identity.ts`   | Agent DID and keypair management                 |
| `agent-events.ts`     | Agent event type definitions                     |

### Real-Time Hooks

| Hook                         | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `useConnectionTelemetry`     | WebSocket connection state and event stream |
| `usePortfolioTelemetry`      | Real-time portfolio balance updates         |
| `useReceipt`                 | Encrypted receipt fetching and decryption   |
| `useTradeHistory`            | Paginated trade history with polling        |

---

## Database Schema

GhostBroker uses Supabase (managed PostgreSQL) with Row-Level Security. The
schema consists of 13 tables:

### Core Tables

**`institutions`** -- Institutional trading entities.
- `t3_tenant_did` (unique) -- Terminal 3 tenant DID
- `settlement_profile_ref` -- Settlement rail selection
- `status` -- `pending`, `active`, `suspended`, `closed`

**`agents`** -- Admitted trading agents.
- `agent_did` -- Terminal 3 agent DID
- `authority_ref` -- Current delegation VC authority reference
- `instrument_scope` -- Allowed trading instruments
- `direction_scope` -- Allowed trading directions (buy/sell)
- `max_notional` -- Maximum notional value per trade
- `policy_hash` -- SHA-256 fingerprint of the delegation VC

**`api_keys`** -- Per-institution API keys for agent authentication.
- `key_bcrypt` -- bcrypt(token, cost=12) of the full key. NOT unique
  (per-call salt). Constant-time verified at request time.
- `lookup_key` (unique while active) -- HMAC-SHA256(AUTH_SESSION_SECRET, token),
  hex. The equality lookup key on the request path.
- `prefix` -- Display prefix for identification
- `scopes` -- Permission scopes (default: `agent:operate`)

### Trading Tables

**`negotiation_mandates`** -- Agent negotiation authority envelopes.
- 30+ columns covering operator-authored policy and derived numeric rails
- Valuation, concession, disclosure, approval, and counterparty policies
- `policy_hash` -- Links back to the delegation VC

**`negotiation_sessions`** -- Active and completed negotiation sessions.
- `status` -- 8-state enum (pairing through settled)
- `delegation_credentials` -- Snapshotted per-side delegation VCs
- `escalation_status` -- Operator approval gate state

**`negotiation_rounds`** -- Individual negotiation moves.
- `move_type` -- 7-type enum (propose, counter, reveal, request_disclosure,
  accept, hold, walkaway)
- `proposal_ciphertext` -- Encrypted price/quantity
- `strategic_intent`, `confidence` -- LLM decision metadata

**`negotiation_disclosures`** -- Selective claim disclosures.
- `claim_assertion_ciphertext` -- Encrypted claim data
- `t3_attestation_ref` -- TEE attestation reference

**`intent_locks`** -- Portfolio reservation locks for active intents.
- `intent_handle` -- TEE-sealed intent handle (primary key)
- `amount` -- Locked portfolio amount

### Settlement Tables

**`completed_trades`** -- Settled trade records.
- All trading data stored as ciphertext columns
- `rail_id`, `rail_trade_ref`, `rail_state` -- Settlement rail tracking
- `reconciled_at` -- Reconciler verification timestamp
- `negotiation_session_id` -- Links to the originating session

**`audit_receipts`** -- Encrypted audit receipts per institution per trade.
- `receipt_ciphertext` -- Encrypted receipt payload
- `receipt_hash` -- SHA-256 of the receipt
- `access_scope` -- `buyer`, `seller`, or `regulatory_export`

### Governance Tables

**`agent_authority_revocations`** -- Authority revocation records.
- `reason` -- `operator_revoked`, `policy_replaced`,
  `credential_compromised`, `terminal3_revoked`
- `unrevoked_at` -- Optional reinstatement timestamp

**`portfolios`** / **`portfolio_history`** -- Asset balances and change history.
- `balance` -- Current balance (check >= 0)
- `locked` -- Amount locked by active intents
- `change_type` -- `settlement_buy`, `settlement_sell`, `adjustment`, `import`

---

## API Reference

The backend exposes 13 route modules listed below.

### Authentication Routes (`/api/auth`)

| Method | Endpoint                | Purpose                              |
| ------ | ----------------------- | ------------------------------------ |
| GET    | `/api/auth/challenge`   | Request DID authentication challenge |
| POST   | `/api/auth/verify`      | Verify wallet signature, issue JWT   |
| POST   | `/api/auth/api-key`     | Exchange API key for session JWT     |

### Institution Routes (`/api/institutions`)

| Method | Endpoint                          | Purpose                       |
| ------ | --------------------------------- | ----------------------------- |
| GET    | `/api/institutions`               | List institutions              |
| GET    | `/api/institutions/:id`           | Get institution details        |
| POST   | `/api/institutions`               | Create institution             |
| PATCH  | `/api/institutions/:id`           | Update institution settings    |
| POST   | `/api/institutions/:id/approve`   | Approve chain rail allowances  |
| POST   | `/api/institutions/:id/withdraw`  | Withdraw from deposit wallet   |

### Agent Routes (`/api/agents`)

| Method | Endpoint                              | Purpose                     |
| ------ | ------------------------------------- | --------------------------- |
| POST   | `/api/agents/admit`                   | Admit agent with delegation VC |
| GET    | `/api/agents`                         | List admitted agents         |
| POST   | `/api/agents/:id/intents`             | Submit hidden intent         |
| GET    | `/api/agents/:id/intents`             | List agent intents           |
| DELETE | `/api/agents/:id/intents/:handle`     | Cancel intent                |
| POST   | `/api/agents/:id/mandate`             | Create negotiation mandate   |

### Negotiation Routes (`/api/negotiations`)

| Method | Endpoint                                    | Purpose                |
| ------ | ------------------------------------------- | ---------------------- |
| GET    | `/api/negotiations/sessions`                | List negotiation sessions |
| GET    | `/api/negotiations/sessions/:id`            | Get session details     |
| POST   | `/api/negotiations/sessions/:id/move`       | Submit negotiation move |
| POST   | `/api/negotiations/sessions/:id/approve`    | Approve escalation      |
| POST   | `/api/negotiations/sessions/:id/decline`    | Decline escalation      |

### Additional Routes

| Method | Endpoint                              | Purpose                     |
| ------ | ------------------------------------- | --------------------------- |
| GET    | `/api/health`                         | Health check and T3 status  |
| GET    | `/api/portfolios/:id`                 | Portfolio balances           |
| GET    | `/api/portfolios/:id/history`         | Portfolio change history     |
| GET    | `/api/trades`                         | Completed trade history      |
| GET    | `/api/receipts/:id`                   | Audit receipt access         |
| POST   | `/api/api-keys`                       | Create API key               |
| POST   | `/api/hosted-agents/start`            | Start hosted agent process   |
| POST   | `/api/hosted-agents/stop`             | Stop hosted agent process    |
| POST   | `/api/admin/trades/:ref/reverse`      | Reverse settled trade (admin)|

---

## Getting Started

### Prerequisites

- Node.js >= 20.19.0
- npm >= 10.0.0
- A Terminal 3 developer key (claim at https://www.terminal3.io/claim-page)
- A Supabase project (free tier is sufficient for development)
- At least one LLM provider API key (Gemini, OpenAI, or Groq)

### Installation

```sh
# Clone the repository
git clone https://github.com/zaikaman/GhostBroker.git
cd GhostBroker

# Install all workspace dependencies
npm install
```

This single `npm install` sets up both the `frontend` and `backend`
workspaces plus all shared dependencies.

### Quick Start

```sh
# 1. Copy environment templates
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# 2. Fill in backend/.env with your credentials (see Environment Configuration)

# 3. Start the backend API server
npm run dev:backend

# 4. In a separate terminal, start the frontend dev server
npm run dev:frontend

# 5. Open http://localhost:5173 in your browser
```

---

## Environment Configuration

The backend requires a `.env` file at `backend/.env`. Copy from
`backend/.env.example` and configure the following groups:

### Required Variables

| Variable                | Description                                   |
| ----------------------- | --------------------------------------------- |
| `PORT`                  | HTTP server port (default: `3001`)            |
| `AUTH_SESSION_SECRET`   | 32+ char hex secret for JWT signing           |
| `SUPABASE_URL`          | Supabase project URL                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key                 |
| `T3N_API_KEY`           | Terminal 3 developer key                      |
| `T3N_ENV`               | T3 environment: `testnet` or `production`     |
| `T3_ADK_ENV`            | T3 ADK environment: `sandbox`, `testnet`, or `production` (default: `sandbox`) |
| `SETTLEMENT_ASSET_CODE` | Settlement denomination (default: `USDC`)     |

### LLM Provider Keys (for hosted agents)

Every provider that has a credential MUST also have an explicit `*_BASE_URL`.
The LLM clients (`gemini-client.ts`, `openai-client.ts`, `groq-client.ts`)
no longer ship default endpoints — operators point each provider at the
documented endpoint for their own deployment (Google Gemini, OpenAI /
Azure OpenAI, Groq Cloud, or a sanctioned self-hosted proxy). Missing
`*_BASE_URL` fails fast at agent env-load time with a clear "config" error.

| Variable             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `GEMINI_API_KEY`     | Google Gemini API key                                 |
| `GEMINI_MODEL`       | Gemini model (default: `gemini-3.1-flash-lite`)       |
| `GEMINI_BASE_URL`    | Required when `GEMINI_API_KEY` is set (e.g. `https://generativelanguage.googleapis.com/v1beta`) |
| `OPENAI_API_KEY`     | OpenAI API key                                        |
| `OPENAI_MODEL`       | OpenAI model (default: `gpt-5-nano`)                  |
| `OPENAI_BASE_URL`    | Required when `OPENAI_API_KEY` is set (e.g. `https://api.openai.com/v1` or Azure OpenAI deployment URL) |
| `GROQ_API_KEY`       | Groq API key                                          |
| `GROQ_MODEL`         | Groq model (default: `qwen/qwen3-32b`)                |
| `GROQ_BASE_URL`      | Required when `GROQ_API_KEY` is set (e.g. `https://api.groq.com/openai/v1`) |

### Chain Rail Variables (opt-in)

| Variable                                             | Description           |
| ---------------------------------------------------- | --------------------- |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL`              | Sepolia RPC endpoint  |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`   | Relayer signing key   |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS` | Deployed relayer   |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED`  | HMAC deposit seed     |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID`             | Chain ID (default: 11155111) |

The chain rail is fully opt-in: omitting any of the first three variables
disables on-chain settlement without breaking existing flows.

---

## Running the Platform

### Development

```sh
# Backend (Express + WebSocket on port 3001)
npm run dev:backend

# Frontend (Vite dev server on port 5173)
npm run dev:frontend

# Both in separate terminals, or use the workspace commands:
npm run dev --workspace @ghostbroker/backend
npm run dev --workspace @ghostbroker/frontend
```

### Agent CLIs

```sh
# Run the hosted agent (multi-provider LLM negotiator)
npm run hosted

# Run standalone buyer agent
npm run buyer

# Run standalone seller agent
npm run seller

# Check Terminal 3 sandbox status
npm run sandbox:check
```

### Contract Operations

```sh
# Build the matching policy contract (Rust -> WASM)
npm run contract:build:matching --workspace @ghostbroker/backend

# Publish the matching contract to T3N
npx tsx scripts/publish-matching.ts

# Verify the published contract
npx tsx scripts/verify-matching-contract.ts

# Build the settlement relayer contract (Solidity)
npm run contract:build:relayer --workspace @ghostbroker/backend
```

### Type Checking

```sh
# Type-check all workspaces
npm run typecheck
```

---

## Testing

GhostBroker ships with a comprehensive test suite: **577 tests passing,
8 skipped across 110 test files** (the 8 skipped tests live in the
on-chain settlement suite behind `WS2_ANVIL_INTEGRATION=1`; the 1 skipped
test file is the root-level Playwright E2E spec which runs under
`npm run test:e2e` instead of `npm test`).

### Running Tests

```sh
# Run all workspace tests
npm test

# Run with on-chain integration tests (requires Anvil)
WS2_ANVIL_INTEGRATION=1 npm test

# Watch mode
npm run test:watch

# E2E tests (Playwright)
npm run test:e2e
```

### Test Distribution by Module

| Module | Test files | Tests passing | Tests skipped |
|---|---|---|---|
| **frontend** (workspace, jsdom) | **17** | **69** | **0** |
| **backend** (workspace, node) | **92** passed + **1** skipped | **508** | **8** (chain-sepolia, gated) |
| **Total** | **110** (109 passed + 1 skipped) | **577** | **8** |

### Test Categories

**Contract tests** (16 files) -- HTTP-level API contract tests via Supertest:
agent admission, intent submission/cancellation/privacy, authentication,
institution CRUD, portfolio management, trade history, receipts, WebSocket
events, and admin operations.

**Integration tests** (24 files) -- Service-level integration tests:
settlement atomicity, matching orchestrator fills and reservations, intent
lock lifecycle, settlement rail dispatch (chain-sepolia, compensation),
hosted agent management, and telemetry redaction.

**Unit tests** (18 files) -- Isolated unit tests: public error handling,
deposit wallet service, operator auth sessions, portfolio service, privacy
redaction, settlement reconciler, and negotiation orchestrator.

**Frontend tests** (17 files) -- React component and service tests via
Testing Library: agent panels, deployment guide, completed trades, deposit
wallet, encrypted receipts, live activity stream, processing status,
settlement profile, accessibility, and privacy redaction.

**Agent SDK tests** (9 files) -- SDK client tests: auth client, delegation
signer, ghostbroker client, intent client, portfolio client, receipt client,
trades client, and WebSocket client.

**Agent runtime tests** (8 files) -- LLM decision validation, negotiation
decision, negotiation loop, sealed envelope, VC verifier, and delegation
tests (126 passing tests).

### On-Chain Integration Tests

The 8 skipped tests are gated behind `WS2_ANVIL_INTEGRATION=1` and require a
local Anvil node. They deploy a `GhostBrokerSettlementRelayer` contract plus
2 minimal ERC-20s, fund and approve the relayer, dispatch a real trade,
decode the on-chain `Settled` event, and assert `Transfer` balance
round-trips.

---

## Deployment

### Frontend (Vercel)

The frontend is a standard Vite build deployable to Vercel:

```sh
cd frontend
npm run build    # tsc --noEmit && vite build
```

Set `VITE_API_URL` to the backend URL in Vercel environment variables.

### Backend (Heroku)

The backend includes a `Procfile` for Heroku deployment:

```
web: npm start
```

```sh
cd backend
npm run build    # tsc -p tsconfig.json
npm start        # node dist/server.js
```

Configure all environment variables from `backend/.env.example` in the
Heroku dashboard.

---

## Design & Product Documents

| Document                                     | Description                         |
| -------------------------------------------- | ----------------------------------- |
| `DESIGN.md`                                  | Design system specification         |
| `PRODUCT.md`                                 | Product brief and brand personality |
| `terminal3-adk-onboarding-doc-gaps.md`       | T3 ADK onboarding gaps filed        |

---

## Terminal 3 ADK Onboarding Gaps Filed

Per the bounty criteria, the Terminal 3 ADK documentation gaps and onboarding
friction points encountered during development are comprehensively tracked in
`terminal3-adk-onboarding-doc-gaps.md` (62,166 bytes). The largest
classes of friction:

1. **Programmatic AI agent delegation is undocumented.** The T3N Dashboard
   delegation flow is documented; the SDK/API surface for the same operation
   is not. GhostBroker works around this by making the backend own the
   persisted VC: the dashboard mints and signs the VC at agent configuration
   time, persists it on the `agents` row, and re-verifies it on every
   privileged call via `loadAndVerify`.

2. **`agent-auth` Host API is marked "coming soon."** The Host API table in
   the ADK documentation marks `agent-auth` as not yet available to app
   contracts. GhostBroker built against the assumption it is not available
   and used the documented Dashboard delegation path.

3. **Typed error handling is missing.** The ADK returns human-readable
   detail strings; GhostBroker performs substring matching in an adapter to
   map to internal categories (`authority_denied`, `map_acl_denied`,
   `token_metering_failed`, etc.).

---

## Why This Submission Fits the Bounty

- **Agent Auth SDK integration is load-bearing, not cosmetic.** Every
  privileged backend action goes through `T3AgentAuthorizationFacade`.
  The admit-time path calls `verifyAgentAuthority` on the inline VC;
  every subsequent privileged action calls `loadAndVerify` on the
  persisted VC; both paths run the same
  `verifyGhostbrokerDelegationCredential` function with the same shape,
  time-window, DID-binding, and revocation checks.

- **The architecture matches the SDK's design intent.** The two-tier model
  (session credential + per-action authority) is the one the Terminal 3
  docs describe for the seed-API-key pattern, applied to the agent
  boundary.

- **The privacy story is enforceable, not aspirational.** Active order
  parameters never enter any external surface; the `redact-event` layer
  is unit-tested against an explicit deny list; the schema and API
  response shapes are built around the boundary.

- **The code is production-ready and tested.** 577 tests passing, 8 skipped
  across 110 test files;
  `tsc --noEmit` clean on both workspaces; the verifier has its own test
  file with positive and negative cases; the session and authority layers
  are independently exercised.

- **The solution is complete.** The repository ships a full-stack platform
  with frontend Observatory Console, backend API, WebSocket telemetry,
  TEE smart contracts (Rust + Solidity), an external agent SDK, hosted
  LLM agents, on-chain ERC-20 settlement, comprehensive documentation,
  and a complete test suite.

---

## License

This project was built for the Terminal 3 Agent Dev Kit Bounty (June 2026).
