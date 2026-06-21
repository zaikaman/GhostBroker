# GhostBroker — DoraHacks Submission

**Institutional Dark Pool with Verifiable Agent Authority**
**Bounty track:** Terminal 3 Agent Dev Kit Bounty (June 9--22, 2026)
**Repository:** https://github.com/zaikaman/GhostBroker

GhostBroker is a production-grade institutional dark-pool trading platform where autonomous agents submit buy and sell intents that are matched and settled inside a Terminal 3 Trusted Execution Environment without any counterparty ever seeing another counterparty's parameters. Active order data lives exclusively inside the TEE; the dashboard, the REST API, the Supabase rows, the WebSocket telemetry stream, and the on-chain settlement layer see only opaque handles, sanitized state labels, and post-settlement audit receipts. Agents are admitted and authorized through Ghostbroker-style W3C Verifiable Credentials, re-verified by the SDK on every privileged action. Humans operate a read-only Observatory Console to monitor connectivity and review completed history.

The bounty fit is direct: every privileged backend action — agent admission, intent submission, intent cancellation, settlement execution, and the five negotiation move types — passes through a single SDK-anchored verifier (`verifyVc` from `@terminal3/verify_vc`), backed by a real WASI P2 contract inside the T3N enclave.

---

## Bounty Criteria Mapping

### 1. How complete is the solution

| Surface | Evidence |
|---|---|
| Test suite | **676 tests passing, 8 skipped across 118 test files** (8 gated by `WS2_ANVIL_INTEGRATION=1`; Playwright E2E under `npm run test:e2e`) |
| Workspaces | npm workspaces monorepo: `frontend/`, `backend/`, `database/`, `tests/` |
| Backend | Express 5 + ws + Zod 4 + Pino, 13 route modules, 31 service modules, hosted multi-provider LLM agent runtime, settlement rail registry |
| Frontend | React 19 + Vite 8, 23 components, Observatory Console |
| Smart contracts | **Rust WASI P2 matching contract v0.13.0** (`backend/contracts/matching-policy/`, ~2000 LOC, compiled to `matching_policy.wasm`) **and** **Solidity Sepolia settlement relayer** (`backend/contracts/relayer/`, Foundry, deployed) |
| Agent SDK | Published Node.js TypeScript client (`@ghostbroker/agent-client`, 21 files, 55 tests) |
| Database | 15-table Supabase schema with RLS; opaque per-field ciphertexts on `completed_trades` |
| Heroku durability | All state Supabase-backed; no `backend/output/` file writes, survives dyno restarts |
| Doc gap report | 19 findings in `terminal3-adk-onboarding-doc-gaps.md` (T3-ONB-001 through T3-ONB-019) |

### 2. How well integrated is the Agent Auth SDK

The Terminal 3 SDK is **load-bearing infrastructure**, not a wrapper. Every privileged action re-runs the same verifier.

**The verifier call site** — `backend/src/enclave/auth/ghostbroker-delegation.ts:373`:
```ts
const result = await verifyVc(signed, { debug: process.env.VC_VERIFY_DEBUG === "true" });
return result.isValid ? "verified" : "rejected";
```

`verifyVc` is imported from `@terminal3/verify_vc`. The verifier:
1. Parses the VC into the SDK's `SignedCredential` shape, normalizing `issuanceDate` → `validFrom`, `expirationDate` → `validUntil`, and EIP-55-checksumming `proof.verificationMethod`.
2. Enforces time window, DID binding, and revocation.
3. Calls `verifyVc` with `EcdsaSecp256k1Signature2019` proof — the SDK recovers the signer via `keccak256(JSON.stringify(body))` + `ethers.verifyMessage` and asserts the recovered EIP-55 address is in `verificationMethod`.
4. **Fails closed** on any exception. No `sandbox` mode, no `structural` fallback. Mode is hard-coded `live` (`ghostbroker-delegation.ts:159`).

**Actions protected:** `agent.admit`, `intent.submit`, `intent.cancel`, `settlement.execute`, `negotiation.open`, `negotiation.move`, `negotiation.disclose`, `negotiation.settle`. Every one re-runs `verifyGhostbrokerDelegationCredential` on each call.

**`T3NegotiationDisclosureVerifier`** is a second, independent SDK-backed verifier on the negotiation hot path (`backend/src/enclave/negotiation/disclosure-verifier.ts`). It calls `verifyVc` to check the JWS on every counterparty claim disclosure. The SDK is the sole cryptographic authority — no manual ECDSA fallback, both branches fail closed.

**Server-side VC persistence:** at admission the dashboard mints and signs the VC via `BackendTenantDelegationSigner`; the backend persists it on the `agents` row; every subsequent privileged action loads it via `loadAndVerify`. The VC is not echoed by agents on every call.

**Two-key separation:** `backend/src/enclave/sandbox/tenant-identity-store.ts:111-127` rejects any `signingPrivateKey` that is not canonical 32-byte secp256k1 hex, preventing T3N bearer API key conflated with the tenant signing key (T3-ONB-014).

**Integration tests pin the SDK:** `agent-auth-sdk-integration.test.ts` asserts `expect(verifyVcSpy).toHaveBeenCalledTimes(1)`. `auth-agent-client.test.ts` runs the **real** SDK against a freshly-minted VC and asserts `result.status === "verified"`. `ghostbroker-delegation-fail-closed.test.ts` proves the verifier rejects when the SDK throws.

**T3N client is real:** `t3n-client.ts` imports 9 named exports from `@terminal3/t3n-sdk`, does a real `handshake()` + `authenticate()` round-trip.

**Private maps are real:** `SealedSecretMapProvisioner` provisions `secrets`, `authority-claims`, `match-config`, `settlement-config` tails via `tenant.maps.create()` with explicit readers/writers.

### 3. How creative is the agentic solution

Three patterns the bounty brief does not pre-supply:

**Hidden-intent dark pool across a live negotiation engine.** Agents do not post standing orders; they seal per-session tickets and engage in turn-based bilateral negotiation. The matching contract only ever sees opaque `intent_handle`s; settlement amounts are persisted as AES-256-GCM ciphertexts (wire form `aead.v1:<nonce_hex>:<ciphertext_hex>`) on `completed_trades`, keyed by per-trade, per-field HKDF-SHA256 keys derived from `ENVELOPE_ENCRYPTION_MASTER_KEY`. A DB breach alone cannot recover plaintext.

**Authority-bound LLM strategy.** Hosted agents run a multi-provider LLM chain (Gemini → OpenAI → Groq) under a per-agent negotiation mandate. The LLM proposes a move; the orchestrator clamps it against the agent's verifiable authority envelope before submission. The mandate derives from the same delegation VC the SDK verified. Mid-session revocation halts future moves automatically.

**Selective disclosure ladder as the negotiation gate.** Convergence requires both a price cross *and* a satisfied disclosure gate. Claims are sealed with `t3_attestation_ref`s; the operator sees only that disclosure happened, never the contents.

---

## Architecture

```
                                  Observatory Console
                                   (React + Vite)
                                        |
                                        | REST + WebSocket
                                        v
                              +--------------------+
                              |   Express Backend   |
                              +--------------------+
                             /    |       |        \
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
                               +-------------+
```

Active hidden intent parameters never cross the enclave boundary into REST responses, WebSocket events, database rows, or server logs. Enforced at three layers: API schema (Zod rejects plaintext intent params), WebSocket telemetry (`redact-event.ts` allowlist), and database (`completed_trades` stores per-field AES-256-GCM ciphertexts minted inside the TEE).

### Repository Structure

```
backend/                           Express + WebSocket + TEE integration
  contracts/matching-policy/       Rust WASI P2 TEE contract
  contracts/relayer/               Solidity Sepolia settlement relayer
  src/enclave/                     Terminal 3 ADK boundary layer
  src/cli/agents/                  Hosted multi-provider LLM agent runtime
  src/sdk/agent-client/            Published Node.js TypeScript SDK
frontend/                          React + Vite Observatory Console
database/                          Supabase schema + RLS + migrations
tests/                             Playwright E2E configuration
terminal3-adk-onboarding-doc-gaps.md  T3 ADK onboarding gaps report
```

### Technology Stack

| Layer | Technology |
|---|---|
| Backend | Node.js >= 20.19, TypeScript 6.0, Express 5.2, ws 8.21 |
| Database | Supabase (PostgreSQL) via @supabase/supabase-js |
| Terminal 3 SDK | @terminal3/t3n-sdk 3.5, @terminal3/verify_vc 0.0.38 |
| Cryptography | @noble/curves 2.2, @noble/hashes 1.5, ethers |
| Blockchain | viem 2.52 (Sepolia ERC-20 settlement) |
| Validation/Logging | Zod 4.4, Pino 10.3 |
| Frontend | React 19.2, Vite 8.0 |
| Smart contracts | Rust (WASI P2, wit-bindgen), Solidity (Foundry) |
| Testing | Vitest 4.1, Supertest 7.2, Testing Library, Playwright 1.60 |
| Infrastructure | Vercel (frontend), Heroku (backend), T3N (TEE) |

---

## Server-Side VC Persistence

1. At admission, the dashboard mints and signs the VC via `BackendTenantDelegationSigner`.
2. The VC is persisted on the `agents` database row.
3. On every subsequent privileged call, `T3AgentAuthorizationFacade` calls `loadAndVerify`, which looks up the persisted VC and runs the full verification pipeline.
4. The same `verifyGhostbrokerDelegationCredential` function is the only verifier behind both the admit-time and per-action paths.

## Two-Tier Authentication

| Layer | Credential | Purpose |
|---|---|---|
| **Session** | `gbk_...` API key → 8-hour JWT | Authenticate the agent across reconnects |
| **Authority** | Ghostbroker delegation W3C VC | Authorize per-action against institution policy |

API keys stored as `key_bcrypt` (bcrypt cost=12) + `lookup_key` (HMAC-SHA256). Operator auth uses T3 DID challenge-response (`GET /api/auth/challenge` + wallet signature → `POST /api/auth/verify`).

---

## Negotiation Engine

Turn-based bilateral negotiation within verifiable authority rails. State machine: `pairing → active → converged → settling → settled` (with `walked_away`, `expired`, `awaiting_approval` branches).

The `NegotiationOrchestrator` (1,968 lines) manages ticket sealing, compatibility-aware pairing (same asset, opposite side, different institution), turn-based moves (`propose`/`counter`/`reveal`/`accept`/`hold`/`walkaway`), price validation against mandate rails, disclosure gate, escalation, and settlement. Each agent's mandate defines objective, execution style, valuation, concession, disclosure, approval, counterparty, and size policy. The `negotiation-core` module (27 tests) provides shared strategy math for both backend and agent runtime.

## Settlement Rails

Single pluggable rail: `chain:sepolia:erc20` — a real `GhostBrokerSettlementRelayer` Solidity contract deployed on Sepolia. Settlement flow: `SettlementCommandBuilder` re-verifies the delegation VC → `MapSettlementRailDispatcher` selects the rail → the rail broadcasts `settle(...)` → `PortfolioService` updates balances → audit receipts generated. The relayer signer is `ViemWalletRelayerSigner` (v1 demo) with a seam for `TeeAttestedRelayerSigner` in production.

## TEE Smart Contracts

**Matching Policy Contract (Rust/WASI P2):** `seal-intent` mints opaque `intent_handle` + `execution_ref`. `evaluate-match` mints outcome, matched quantity, execution price (midpoint), and `match_attestation_ref` cryptographically binding per-side identity.

**Settlement Relayer (Solidity/Foundry):** `GhostBrokerSettlementRelayer.sol` handles atomic ERC-20 transfers. Deployed on Ethereum Sepolia.

## Agent Client SDK

`@ghostbroker/agent-client` (21 files, 55 tests): `GhostBrokerClient`, `DelegationSigner`, `AuthClient`, `IntentClient`, `NegotiationClient`, `PortfolioClient`, `TradesClient`, `ReceiptClient`, `WebSocketClient`.

## Hosted LLM Agents

Multi-provider LLM chain: Gemini (priority 1) → OpenAI (2) → Groq (3). Agent lifecycle: identity setup → delegation claim → admission → settlement pre-clear → negotiation loop → settlement. `negotiation-decision.ts` validates every LLM decision (price band, quantity target, notional ceiling, reasoning, confidence) before submission.

---

## Database Schema

15 tables with RLS. Core: `institutions`, `agents`, `api_keys`. Trading: `negotiation_mandates`, `negotiation_sessions` (8-state enum), `negotiation_rounds` (7-type move), `negotiation_disclosures`, `intent_locks`. Settlement: `completed_trades` (ciphertext columns), `audit_receipts`. Governance: `agent_authority_revocations`, `portfolios`/`portfolio_history`. Runtime: `published_contracts`, `tenant_identities`.

---

## API Reference

13 route modules. **Auth:** `GET /api/auth/challenge`, `POST /auth/verify`, `POST /auth/api-key`. **Institutions:** CRUD + `/approve`, `/withdraw`. **Agents:** `POST /admit`, list, `POST /:id/intents`, list intents, `DELETE /:id/intents/:handle`, `POST /:id/mandate`. **Negotiations:** `GET /sessions`, `GET /sessions/:id`, `POST /sessions/:id/move`, `/approve`, `/decline`. **Other:** health, portfolio, trades, receipts, API keys, hosted agents, admin reversals.

---

## Getting Started

### Prerequisites
- Node.js >= 20.19.0, npm >= 10.0.0
- Terminal 3 developer key, Supabase project, at least one LLM provider API key
- **Sepolia testnet setup (REQUIRED):** RPC endpoint, relayer account funded with ~0.05 Sepolia ETH, Foundry

### Installation
```sh
git clone https://github.com/zaikaman/GhostBroker.git
cd GhostBroker
npm install
```

### Quick Start
```sh
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Fill in AUTH_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# T3N_API_KEY, GEMINI_API_KEY + GEMINI_BASE_URL (or OpenAI/Groq equivalents)
# Then bring up Sepolia settlement rail:
cd backend/contracts/relayer && forge build && node deploy.mjs && cd ../../..
# Start both services:
npm run dev:backend
npm run dev:frontend      # separate terminal
# Open http://localhost:5173
```

### Judge Demo Path
Connect wallet (DID challenge) → provision agent → watch LLM-vs-LLM negotiation → verify SDK attestation in Settings.

## Environment Configuration

| Variable | Description |
|---|---|
| `AUTH_SESSION_SECRET` | 32+ char hex for JWT signing |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase project |
| `T3N_API_KEY` | Terminal 3 developer key |
| `T3N_ENV` / `T3_ADK_ENV` | `testnet` or `production` |
| `GEMINI_API_KEY` + `GEMINI_BASE_URL` | Gemini LLM (default model: `gemini-3.1-flash-lite`) |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | OpenAI LLM (default model: `gpt-5-nano`) |
| `GROQ_API_KEY` + `GROQ_BASE_URL` | Groq LLM (default model: `qwen/qwen3-32b`) |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL` | Sepolia RPC endpoint |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY` | Relayer account (funded with Sepolia ETH) |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS` | Deployed relayer |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED` | 32-byte hex HMAC seed |

After boot, each institution's deposit wallet must `approve(relayer, MAX)` for WBTC and USDC (walked through in the frontend).

---

## Testing

**676 tests passing, 8 skipped across 118 test files.**
```sh
npm test                              # all workspace tests
WS2_ANVIL_INTEGRATION=1 npm test      # with on-chain (requires Anvil)
npm run test:watch                    # watch mode
npm run test:e2e                      # Playwright E2E
```

| Module | Files | Tests |
|---|---|---|
| frontend (jsdom) | 18 | 73 |
| backend (node) | 99 + 1 skipped | 603 (8 skipped, gated) |
| **Total** | **118** | **676** |

Categories: contract (16, Supertest), integration (25), unit (21), frontend (18, React), SDK (9), agent runtime (7, 120 tests). On-chain integration deploys a relayer against a local Anvil node and asserts on-chain Transfer round-trips.

---

## Deployment

Two independent services: **Frontend** (Vercel, Vite + React SPA) and **Backend** (Heroku, Node.js web dyno running REST, WebSocket, matching orchestrator, intent-lock janitor, settlement reconciler, hosted-agent supervisor, T3 enclave bridge, Sepolia rail). The `Procfile` declares a single `web` process; `app.json` has the full env-var contract for one-click deploys.

## Terminal 3 ADK Onboarding Gaps

19 findings (P0–P3) in `terminal3-adk-onboarding-doc-gaps.md`. Highlights:
- **T3-ONB-018 (P0)** — Wrong digest construction in `verifyEcdsaVcSig`. Fix shipped in `delegation-signer.ts`.
- **T3-ONB-019 (P0)** — Case-sensitive address comparison. Fix via EIP-55 checksum enforcement.
- **T3-ONB-014 (P1)** — API key vs signing key conflated in docs. Fix via shape validation.
- **T3-ONB-001/2/3 (P0)** — Host APIs marked "Coming soon" blocked programmatic delegation. Worked around with authenticated session APIs.

## Why This Submission Wins

- **SDK integration is load-bearing, not cosmetic.** Every privileged action goes through the same `verifyGhostbrokerDelegationCredential` — real, fail-closed, and the only cryptographic authority.
- **Completeness is structural.** Two real on-chain surfaces (WASM + Solidity), 15 tables with RLS, agent SDK with 55 tests, 23 frontend components, hosted multi-provider LLM agents. Nothing is mocked.
- **Creativity is the dark pool itself.** Hidden-intent + turn-based negotiation + selective-disclosure is unsafe or impossible without the SDK's privacy guarantees — the application structurally advertises the SDK's value.