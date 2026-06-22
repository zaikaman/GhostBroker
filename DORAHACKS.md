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
| Test suite | **688 tests passing, 8 skipped across 119 test files** (8 gated by `WS2_ANVIL_INTEGRATION=1`; Playwright E2E runs under `npm run test:e2e`) |
| Workspaces | npm workspaces monorepo: `frontend/`, `backend/`, shared `database/`, `tests/` |
| Backend | Express 5 + ws + Zod 4 + Pino, 13 route modules, 32 service modules, hosted multi-provider LLM agent runtime, settlement rail registry |
| Frontend | React 19 + Vite 8 + hls.js, 23 components, dedicated Observatory Console |
| Smart contracts | **Real Rust WASI P2 matching contract v0.15.1** (`backend/contracts/matching-policy/`, ~2300 LOC: v0.9.0 round-flow additions + v0.9.1 in-enclave AEAD decryption + v0.10.0 kv-store-backed state + v0.13.0 real AES-256-GCM settlement ciphertexts + **v0.15.1 SDK-native delegation envelope support -- per-agent TEE calls accept `delegation_envelope` and the contract verifies the credential authorises the called function**, compiled to `matching_policy.wasm`, published to T3N testnet contract_id 439, imports `host:tenant/tenant-context@1.0.0` and `host:interfaces/logging@2.1.0`) **and** a **real Solidity Sepolia settlement relayer** (`backend/contracts/relayer/`, Foundry, deployed) |
| Agent SDK | Published Node.js TypeScript client (`@ghostbroker/agent-client`, 22 files, 10 test files) covering auth, intents, negotiation, portfolio, trades, receipts, WebSocket |
| Database | 15-table Supabase schema with RLS policies (13 original + `published_contracts`, `tenant_identities`); opaque per-field correlation handles on `completed_trades` |
| Heroku durability | All runtime state is Supabase-backed (no `backend/output/` file writes); the tenant signing keypair and the T3N publish record both survive Heroku dyno restarts and Heroku's ephemeral dyno filesystem |
| Documentation gap report | 19 findings filed in `terminal3-adk-onboarding-doc-gaps.md` (T3-ONB-001 through T3-ONB-019) |

### 2. How well integrated is the Agent Auth SDK

The Terminal 3 SDK is **load-bearing infrastructure**, not a wrapper. Every privileged action re-runs the same verifier.

**SDK-native delegation lifecycle (v3.9.0).** GhostBroker uses the SDK's native delegation primitives as the default minting path. `backend/src/enclave/auth/sdk-delegation-signer.ts` wraps the full lifecycle:

- **Minting**: `buildDelegationCredential` + `canonicaliseCredential` + `signCredential` produce the SDK-native credential (RFC 8785 JCS bytes EIP-191-signed by the tenant keypair). GhostBroker's `allowedActions` enum maps to the matching contract's WIT function names; the richer action scope (`maxSpendUsd`, `approverEmail`, `purpose`) is carried as SDK credential `metadata` labels.
- **Per-call invocation signing**: `buildInvocationPreimage` + `signAgentInvocation` produce the 64-byte compact ECDSA signature the TEE contract receives. The delegation envelope wire (`credential_jcs` + `user_sig` + `agent_sig` + `nonce` + `request_hash` + `functions` + `vc_id`) is forwarded on every per-agent TEE contract call. The TEE contract (v0.15.1) checks the called function is in the credential's `functions` list and echoes `delegation_vc_id` on the output.
- **On-chain revocation**: `revokeDelegation` calls the `tee:delegation/contracts::revoke` entrypoint. `SdkAuthorityRevocationRepository` wraps the Supabase repository and adds the on-chain step with per-function granularity (revoke just `settlement-execute` while keeping `seal-intent` live). Falls back to Supabase-only when the on-chain call fails.
- **Legacy fallback**: the custom `delegation-signer.ts` remains for environments where the SDK delegation contract is not provisioned. The verify side (`@terminal3/verify_vc`'s `verifyVc`) is unchanged -- both paths produce W3C VCs the verifier accepts.
- **Available on the authenticated T3nClient**: `DelegationCustodialClient` (custodial signing for OIDC users). The `T3nClient` is exposed via `SdkAuthenticatedT3NetworkClient.t3nClient` getter for composition roots. The SDK's `getAuditEvents()` API is declared on `T3nClient` and the read path (`audit.get-mine`) works, but the T3N testnet host at `logging@2.1.0` does not implement the `logging::audit` host call contracts need to emit events, so the trail is empty until T3N ships that support.

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
| Terminal 3 SDK | @terminal3/t3n-sdk 3.9, @terminal3/verify_vc 0.0.38 |
| Cryptography | @noble/curves 2.2, @noble/hashes 1.5, ethers |
| Blockchain | viem 2.52 (Sepolia ERC-20 settlement) |
| Validation/Logging | Zod 4.4, Pino 10.3 |
| Frontend | React 19.2, Vite 8.0 |
| Smart contracts | Rust (WASI P2, wit-bindgen), Solidity (Foundry) |
| Testing | Vitest 4.1, Supertest 7.2, Testing Library, Playwright 1.60 |
| Infrastructure | Vercel (frontend), Heroku (backend), T3N (TEE), Sepolia (settlement), LLMs (Gemini, OpenAI, Groq) |

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

The `NegotiationOrchestrator` (2,272 lines) manages ticket sealing, compatibility-aware pairing (same asset, opposite side, different institution), turn-based moves (`propose`/`counter`/`reveal`/`accept`/`hold`/`walkaway`), price validation against mandate rails, disclosure gate, escalation, and settlement. Each agent's mandate defines objective, execution style, valuation, concession, disclosure, approval, counterparty, and size policy. The `negotiation-core` module (27 tests) provides shared strategy math for both backend and agent runtime.

## Settlement Rails

Single pluggable rail: `chain:sepolia:erc20` — a real `GhostBrokerSettlementRelayer` Solidity contract deployed on Sepolia. Settlement flow: `SettlementCommandBuilder` re-verifies the delegation VC → `MapSettlementRailDispatcher` selects the rail → the rail broadcasts `settle(...)` → `PortfolioService` updates balances → audit receipts generated. The relayer signer is `ViemWalletRelayerSigner` (v1 demo) with a seam for `TeeAttestedRelayerSigner` in production.

## TEE Smart Contracts

GhostBroker deploys two categories of smart contracts that run inside the Terminal 3 enclave surface:

### Matching Policy Contract (Rust / WASI P2)

Located at `backend/contracts/matching-policy/`, this crate compiles to a WASI Preview 2 component and runs inside the T3N TEE.

The contract is at version **v0.15.1** (published to T3N testnet, contract_id 439). v0.15.1 carries forward the v0.14.0 SDK-native delegation envelope support: per-agent calls (`seal-ticket`, `seal-intent`, `seal-round-proposal`) accept an optional `delegation_envelope` field and the TEE verifies the credential authorises the called function. The `delegation_vc_id` is echoed on the output for audit trail linkage.

**`seal-intent`** -- Mints:
- `intent_handle` -- `intent_<32 hex>` = SHA-256 of `institution_id|agent_did|encrypted_intent|authority_ref|correlation_ref`. Deterministic, so the orchestrator can deduplicate accidental re-seals.
- `execution_ref` -- `t3exec_<32 hex>` from a fresh monotonic counter.

**`evaluate-match`** -- Mints:
- `outcome_ref` -- `outcome_<32 hex>` = SHA-256 of `buy_intent_handle|sell_intent_handle|correlation_ref`.
- `encrypted_trade_fields_ref` -- `t3fields_<32 hex>` = SHA-256 of `buy_intent_handle:sell_intent_handle`.
- `status` -- `"matched"` when `buy_price >= sell_price` and all fields are valid positive integers; `"no_match"` otherwise.
- `matched_quantity` -- `min(buy_quantity, sell_quantity)` (decimal string).
- `execution_price` -- Deterministic midpoint `(buy_price + sell_price) / 2` rounded half-up (decimal string).
- `match_attestation_ref` -- `match_attest_<32 hex>` = SHA-256 of the canonical concatenation of (buy_intent_handle, buy_institution_id, sell_intent_handle, sell_institution_id, buy_authority_ref, sell_authority_ref, correlation_ref, asset_code, outcome_ref, execution_ref). Cryptographically binds the per-side identity the TEE echoed on the match outcome to the outcome itself, so a judge reading the `completed_trades` row can re-derive the attestation from the recorded fields and confirm the institution IDs in the row are the IDs the TEE bound to the match.

The backend orchestrator is a verifier around the enclave outcome: it filters obvious non-candidates locally, forwards the per-side identity it already holds in its pending-intent queue (the institution IDs and authority refs verified at seal time), then trusts the enclave's decision. As of v0.8.0, the TEE **echoes** the per-side institution IDs and authority refs back on the outcome and binds them to the `match_attestation_ref` above. The orchestrator asserts the echo matches the queue values it submitted and fails closed on mismatch — a poisoned queue entry, a refactor that lost the binding, or a TEE returning different values from what was sent cannot silently settle to an institution the TEE never bound to the match. The settlement record carries the TEE-attested identity (not an orchestrator-stamped override) so the audit trail is cryptographically verifiable.

### Settlement Relayer Contract (Solidity / Foundry)

Located at `backend/contracts/relayer/`, this Foundry project contains the `GhostBrokerSettlementRelayer.sol` contract and `MinimalERC20.sol` for testing. The relayer is deployed to Ethereum Sepolia and handles the atomic ERC-20 token transfers that finalize a matched trade.

## What Is Real vs Simulated

Honest disclosure of the design and implementation details:

### Real and load-bearing
- **The T3 SDK call chain**: `verifyVc` is genuinely called on every privileged action; the agent's delegation VC is real; settlement re-verifies the credential before broadcasting.
- **The SDK-native delegation lifecycle**: `buildDelegationCredential`, `canonicaliseCredential`, `signCredential`, `signAgentInvocation`, `buildInvocationPreimage`, and `revokeDelegation` are all called in production code paths. The delegation envelope is forwarded on every per-agent TEE contract call and the TEE contract (v0.15.1) verifies the credential authorises the function. On-chain revocation via `revokeDelegation` fires on every `revokeAgent` call.
- **The TEE contract**: `matching_policy.wasm` is a real Rust/WASI P2 component compiled from ~2300 LOC, published via `tenant.contracts.publish`, and driven end-to-end through `tenant.contracts.execute` in `verify-matching-contract.ts`. The contract is at v0.15.1, published to T3N testnet (contract_id 439) with a `check_delegation_authority` function-scope gate.
- **Sepolia settlement**: The relayer is a real Solidity contract (`GhostBrokerSettlementRelayer.sol`), deployed; balances update atomically via `viem.writeContract`; `SettlementReconciler` polls `completed_trades` and re-checks `rail.status(railTradeRef)` for drift.
- **LLM clients**: `gemini-client.ts`, `openai-client.ts`, `groq-client.ts` each make real `fetch()` calls to provider-configured endpoints with a multi-provider fallback chain.
- **Two-key separation, revocation, DID binding, EIP-55 canonicalization**: all real and tested.

### Deliberately scoped for the bounty demo (v1)
- `backend/src/cli/agents/sealed-envelope.ts`: For loop agents that do not have a TEE in front of them, the envelope is a real AES-256-GCM AEAD ciphertext (`ghostbroker.envelope.aead/v1`) with a per-institution key derived from `ENVELOPE_ENCRYPTION_MASTER_KEY` via HKDF-SHA256. The Additional Data binds the ciphertext to (institutionDid, agentDid, authorityRef, schema version) to prevent tampering.
- `backend/src/enclave/negotiation/round-client.ts`: Per-round negotiation crosses now route through the T3 negotiation round contract. The hosted agent seals every priced move into an AEAD envelope, the orchestrator forwards the envelope to the TEE's `seal-round-proposal` route, and `evaluate-round` takes both sealed proposal handles and emits the cross verdict + a TEE-attested `round_attestation_ref`. The orchestrator no longer computes the cross inline.

### Dashboard UI surfaces are wired to live data
No dashboard surface displays hardcoded values as live data. The Settings → Enclave Connection panel calls `GET /api/health/enclave` to display real platform identifiers: the tenant DID, the VC issuer DID and signing address, the matching contract identifier and version, and the T3 network environment. Honest "Not configured" states are rendered when environment fields are missing.

## Agent Client SDK

`@ghostbroker/agent-client` (22 files, 10 test files): `GhostBrokerClient`, `DelegationSigner`, `AuthClient`, `IntentClient`, `NegotiationClient`, `PortfolioClient`, `TradesClient`, `ReceiptClient`, `WebSocketClient`.

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
# 1. Copy environment templates
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Fill in AUTH_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# T3N_API_KEY, GEMINI_API_KEY + GEMINI_BASE_URL (or OpenAI/Groq equivalents)

# 2. Bring up the Sepolia settlement rail (REQUIRED):
cd backend/contracts/relayer
forge build                       # compile the relayer
node deploy.mjs                   # deploys to Sepolia and prints contract address
cd ../../..
# ...paste the printed addresses into backend/.env ...

# 3. Start the backend API server
npm run dev:backend

# 4. In a separate terminal, start the frontend dev server
npm run dev:frontend

# 5. Open http://localhost:5173
```

### 60-Second Judge Demo Path
1. **Connect Wallet**: Complete the DID challenge-response via wallet signature.
2. **Provision Agent**: Create an agent (which mints a signed W3C delegation VC server-side).
3. **Hosted Negotiator**: Watch the hosted negotiator run an LLM-vs-LLM negotiation session in real-time.
4. **Settings & Verification**: Verify the SDK attestation details in **Settings → Enclave Attestation**.

Optional verification commands:
```sh
# Verify the published T3N contract against the live tenant
npx tsx backend/scripts/verify-t3n-tenant.ts
npx tsx backend/scripts/verify-matching-contract.ts

# Run on-chain integration (requires local Anvil)
WS2_ANVIL_INTEGRATION=1 npm test
```


## Environment Configuration

The backend requires a `.env` file at `backend/.env` containing:

### Required Variables
| Variable | Description |
|---|---|
| `PORT` | HTTP server port (default: `3001`) |
| `AUTH_SESSION_SECRET` | 32+ char hex secret for JWT signing |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `T3N_API_KEY` | Terminal 3 developer key |
| `T3N_ENV` | T3 environment: `testnet` or `production` |
| `T3_ADK_ENV` | T3 ADK environment: `sandbox`, `testnet`, or `production` (default: `sandbox`) |
| `T3_TENANT_DID` | Terminal 3 tenant DID (`did:t3n:...`) |
| `TENANT_SIGNING_PRIVATE_KEY` | secp256k1 private key used to sign delegation VCs |
| `SETTLEMENT_ASSET_CODE` | Settlement denomination (default: `USDC`) |

### LLM Provider Keys (for hosted agents)
Every LLM provider that has a credential MUST also have an explicit `*_BASE_URL`.
| Variable | Description |
|---|---|
| `GEMINI_API_KEY` + `GEMINI_BASE_URL` | Gemini LLM (default model: `gemini-3.1-flash-lite`) |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | OpenAI LLM (default model: `gpt-5-nano`) |
| `GROQ_API_KEY` + `GROQ_BASE_URL` | Groq LLM (default model: `qwen/qwen3-32b`) |

### Settlement Rail Setup (Sepolia ERC-20)
| Variable | Description |
|---|---|
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL` | Sepolia RPC endpoint URL |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY` | Relayer account (funded with Sepolia ETH for gas) |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS` | Deployed relayer contract address |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED` | 32-byte hex HMAC seed to derive deposit wallets |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS` | Sepolia WBTC ERC-20 address |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS` | Sepolia USDC ERC-20 address |

After boot, each institution's deposit wallet must `approve(relayer, MAX)` for WBTC and USDC (walked through in the frontend).


---

## Testing

**688 tests passing, 8 skipped across 119 test files.**
```sh
npm test                              # all workspace tests
WS2_ANVIL_INTEGRATION=1 npm test      # with on-chain (requires Anvil)
npm run test:watch                    # watch mode
npm run test:e2e                      # Playwright E2E
```

| Module | Files | Tests |
|---|---|---|
| frontend (jsdom) | 18 | 73 |
| backend (node) | 101 | 615 (8 skipped, gated) |
| **Total** | **119** | **688** |

Categories: contract (16, Supertest), integration (25), unit (21), frontend (18, React), SDK (10), agent runtime (7, 120 tests). On-chain integration deploys a relayer against a local Anvil node and asserts on-chain Transfer round-trips.

---

## Deployment

Two independent services: **Frontend** (Vercel, Vite + React SPA) and **Backend** (Heroku, Node.js web dyno running REST, WebSocket, matching orchestrator, intent-lock janitor, settlement reconciler, hosted-agent supervisor, T3 enclave bridge, Sepolia rail). The `Procfile` declares a single `web` process; `app.json` has the full env-var contract for one-click deploys.

## Terminal 3 ADK Onboarding Gaps

Comprehensive friction points and doc gaps encountered during development are tracked in `terminal3-adk-onboarding-doc-gaps.md` (19 findings, severity P0–P3). Highlights:

- **T3-ONB-018 (P0)** — `verifyEcdsaVcSig` uses a wrong digest construction that caused our first signer integration to fail silently until we reconstructed the byte layout by hand. Fix shipped in `backend/src/sdk/agent-client/delegation-signer.ts:295-325` (`sdkRecoveryDigestForHashedJson`).
- **T3-ONB-019 (P0)** — Case-sensitive address comparison in `verifyEcdsaVcSig` against `verificationMethod`. Fix shipped in `backend/src/enclave/sandbox/tenant-identity-store.ts:244-256` (EIP-55 checksum enforcement).
- **T3-ONB-014 (P1)** — T3N bearer API key and tenant secp256k1 signing key are not differentiated in onboarding docs. Fix shipped via explicit shape validation in `tenant-identity-store.ts:111-127`.
- **T3-ONB-001, -002, -003 (P0)** — `did-registry`, `agent-auth`, and `agent-delegations` Host APIs documented as "Coming soon" prevent a programmatic agent delegation flow. We worked around by reusing the SDK's authenticated session APIs.
- 14 additional findings covering token metering, contract publish flow, map ACL semantics, error taxonomy, and example completeness.

## Why This Submission Wins

- **SDK integration is load-bearing, not cosmetic.** Every privileged action goes through the same `verifyGhostbrokerDelegationCredential` — real, fail-closed, and the only cryptographic authority.
- **Completeness is structural.** Two real on-chain surfaces (WASM + Solidity), 15 tables with RLS, agent SDK with 22 files and 10 test files, 23 frontend components, hosted multi-provider LLM agents. Nothing is mocked.
- **Creativity is the dark pool itself.** Hidden-intent + turn-based negotiation + selective-disclosure is unsafe or impossible without the SDK's privacy guarantees — the application structurally advertises the SDK's value.