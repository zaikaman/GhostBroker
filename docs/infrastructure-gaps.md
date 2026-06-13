# GhostBroker Infrastructure Gaps

> Audit date: 2026-06-13
> Scope: Full codebase deep dive assessing readiness for agent-to-agent trading

---

## Overview

GhostBroker has strong **cryptographic primitives** (DID auth, delegation proofs, TEE sealing, encrypted intents) but is missing significant **user-facing infrastructure** needed for agents to actually connect, authenticate, and trade in production.

---

## What Already Exists

### Authentication (DID Challenge-Response)

- `POST /api/auth/challenge` — Requests a cryptographic challenge
- `POST /api/auth/verify` — Submits a signed challenge and returns a JWT session token (8-hour TTL)
- HMAC-SHA256 session tokens stored in `backend/src/auth/session-token.ts`
- Works for both humans (MetaMask `personal_sign`) and agents (ethers.js `Wallet.signMessage`)
- Frontend: `frontend/src/services/wallet-auth.ts`
- Agent SDK: `agent-client/src/auth-client.ts`

### Agent Admission

- `POST /api/agents/admit` — Verifies a Terminal3 delegation credential (cryptographic proof that a wallet authorized an agent)
- Delegation proof verification in `t3-enclave/src/auth/delegation-credential.ts`
- Authority claims model in `t3-enclave/src/auth/authority-claims.ts` (instrumentScope, directionScope, maxNotionalMinorUnits)
- Agent-side builder: `agent-client/src/delegation-proof.ts`

### Hidden Intent Submission & Matching

- `POST /api/agents/intents` — Submits an encrypted trading envelope
- `HiddenIntentService` (`backend/src/services/hidden-intent.service.ts`) coordinates sealing
- `MatchingOrchestrator` (`backend/src/services/matching-orchestrator.ts`) matches pending intents **in memory**
- TEE blind intent client: `t3-enclave/src/matching/blind-intent.ts`
- Match contract client: `t3-enclave/src/matching/match-contract-client.ts`

### Settlement & Portfolio

- `SettlementService` (`backend/src/services/settlement.service.ts`) — Atomic settlement with balance updates
- `PortfolioService` (`backend/src/services/portfolio.service.ts`) — Balance CRUD, adjustment, snapshot sync
- Sepolia wallet sync via Etherscan: `backend/src/services/sepolia-portfolio-sync.service.ts`
- DB tables: `completed_trades`, `audit_receipts`, `portfolios`, `portfolio_history`

### Dashboard (Frontend)

- Strictly watch-only by design
- Components: `AgentConnectionGrid`, `CompletedTradesTable`, `PortfolioHistory`, `EncryptedReceiptDrawer`, `ProcessingStatusRail`, `LiveAgentActivityStream`
- Real-time WebSocket telemetry: `frontend/src/services/telemetry-client.ts`

### Agent Client SDK

- `GhostBrokerClient` — Unified client (`agent-client/src/ghostbroker-client.ts`)
- `AuthClient`, `IntentClient`, `TradesClient`, `ReceiptClient`, `TelemetryClient`
- `DelegationProofBuilder` — Builds signed delegation proofs

---

## Critical Gaps

### Gap 1: No API Key System for Agents

**Status: ✅ Resolved**

Agents can now authenticate using persistent API keys (`gbk_<prefix>_<random>`) instead of re-signing DID challenges every 8 hours.

**What was built:**

| Component | File(s) |
|-----------|---------|
| `api_keys` DB table | `database/migrations/007_create_api_keys.sql` |
| `POST /api/keys` — Generate a new API key | `backend/src/api/api-keys.routes.ts` |
| `GET /api/keys` — List active keys (without secret) | `backend/src/api/api-keys.routes.ts` |
| `POST /api/keys/:id/revoke` — Revoke a key | `backend/src/api/api-keys.routes.ts` |
| API key middleware | `backend/src/auth/api-key-auth.ts`, updated `backend/src/auth/operator-auth.ts` |
| Key-scoped auth context | `backend/src/services/api-key.service.ts` |
| Dashboard UI for key management | `frontend/src/components/ApiKeysPanel.tsx` |

**Key design decisions:**

- Keys are hashed with SHA-256 before storage — plaintext returned only once on creation
- Bearer tokens starting with `gbk_` are routed to API key auth; other tokens fall through to JWT
- Revoke includes `institution_id` check for cross-institution protection
- Keys can be managed from the dashboard UI (generate, list, copy, revoke)
- The frontend `api-client.ts` exposes `listApiKeys()`, `createApiKey()`, `revokeApiKey()`

---

### Gap 2: No Agent-to-Asset Authorization Enforcement

**Severity: 🔴 Blocking**

The authority claim schema (`authority-claims.ts`) defines `instrumentScope`, `directionScope`, `maxNotionalMinorUnits`, but:

- There is **no dashboard UI** to configure these limits
- The `MatchingOrchestrator` does **not check** trading limits before matching
- The portfolio is owned at the **institution level**, not per-agent
- The first agent to submit a buy intent could drain the institution's entire cash balance

**What's needed:**

| Item | Description |
|------|-------------|
| Per-agent limit enforcement | Check instrumentScope, directionScope, maxNotional at matching time |
| Per-agent portfolio sub-accounts | Or at minimum balance reservation against the institution portfolio |
| Dashboard limit configuration | UI for operators to set agent trading limits |

---

### Gap 3: No Agent Key Management Infrastructure

**Severity: 🟡 High**

- Agents need Ethereum private keys to sign DID challenges
- There is no dashboard flow to **generate**, **register**, or **export** agent keys
- The examples (`agent-buyer.ts`, `agent-seller.ts`) require passing `ADMIN_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, and a `CREDENTIAL_JCS_BASE64` from the T3N Dashboard

**What's needed:**

| Item | Description |
|------|-------------|
| Agent key generation | Dashboard UI to generate an Ethereum keypair for a new agent |
| Agent naming/labeling | Human-readable agent names tied to DIDs |
| Secure key export | Download/display the private key once with a "saved" confirmation |
| Automatic delegation | Auto-create the T3N delegation credential from the dashboard |
| Key rotation | Replace an agent's key without re-registering |

---

### Gap 4: No Admitted-Agent Tracking in the Database

**Severity: 🟡 High**

Currently `POST /api/agents/admit` just verifies the delegation proof and returns `{ status: "admitted" }`. There is **no database table** tracking admitted agents:

- All admissions live in-memory only (lost on server restart)
- The `agent_authority_revocations` table exists but there is no base `agents` table to revoke against
- No way to list "which agents does my institution have?"
- No way to audit admission history

**What's needed:**

| Item | Description |
|------|-------------|
| `agents` DB table | id, institution_id, agent_did, status, authority_ref, label, metadata, created_at, updated_at |
| `POST /api/agents/admit` update | Persist admission to DB |
| `GET /api/agents` | List admitted agents for an institution |
| `POST /api/agents/:id/revoke` | Revoke an agent's admission |
| Revocation cascade | Clear active intents on revocation |

---

### Gap 5: Intent Cancellation

**Severity: 🟡 High**

- The API reference explicitly marks cancellation as "coming in a future release"
- Agents cannot cancel a submitted intent
- The only escape from the in-memory queue is the TTL expiry (5 minutes)

**What's needed:**

| Item | Description |
|------|-------------|
| `POST /api/agents/intents/cancel` | Cancel an active intent (gated behind agent authority + TEE) |
| Deletion from pending queue | Remove from `MatchingOrchestrator.pendingIntents` |
| Telemetry notification | Publish cancellation event to WebSocket |

---

### Gap 6: Missing Agent-Related API Endpoints

**Severity: 🟡 Medium**

| Missing Endpoint | Why It's Needed |
|------------------|-----------------|
| `GET /api/agents` | List admitted agents for the authenticated institution |
| `POST /api/agents/:id/revoke` | Revoke an agent's admission credentials |
| `GET /api/agents/intents` | List own active intents (privacy-safe, agent-scoped) |
| `POST /api/agents/intents/cancel` | Cancel an active intent |
| `GET /api/keys` | List/manage API keys for the institution |
| `POST /api/keys` | Generate a new API key |
| `POST /api/keys/:id/revoke` | Revoke an API key |

---

### Gap 7: Portfolio Is Institution-Scoped, Not Agent-Scoped

**Severity: 🟡 Medium**

When settlement runs, it debits/credits the **institution-level portfolio**. Multiple agents trading simultaneously can step on each other's balances:

- No per-agent balance reservation
- No agent-level "maximum spend" limit enforcement
- No agent-level portfolio view
- The `MatchingOrchestrator` calls `matchClient.evaluateMatch()` without checking portfolio balance first

**What's needed:**

| Item | Description |
|------|-------------|
| Pre-match balance check | Verify sufficient balance before calling TEE match |
| Agent balance reservation | Lock a portion of the institution's balance while an intent is pending |
| Agent-level portfolio view | `GET /api/portfolios/:institutionId?agentDid=...` |

---

## Gap Severity Summary

| Gap | Severity | Depends On |
|-----|----------|------------|
| 1 - API Key System | 🔴 Blocking | Nothing |
| 2 - Agent-to-Asset Authorization | 🔴 Blocking | Gap 4 (agent DB) |
| 3 - Agent Key Management | 🟡 High | Gap 4 (agent DB) |
| 4 - Agent DB & Admitted Tracking | 🟡 High | Nothing |
| 5 - Intent Cancellation | 🟡 High | Gap 4 (agent DB) |
| 6 - Missing API Endpoints | 🟡 Medium | Gap 4 (agent DB) |
| 7 - Institution-Scoped Portfolio | 🟡 Medium | Gap 2 (authorization) |

---

## Recommended Implementation Order

1. **API keys** (Gap 1) — Unblocks persistent agent authentication
2. **Agent DB table + admission persistence** (Gap 4) — Foundation for all agent management
3. **Agent management endpoints** (Gap 6) — List, revoke, status
4. **Agent key management UI** (Gap 3) — Dashboard to generate and export agent keys
5. **Intent cancellation** (Gap 5) — Agents can cancel active intents
6. **Agent-to-asset authorization** (Gap 2) — Enforce trading limits
7. **Per-agent portfolio** (Gap 7) — Balance reservations and agent-level views

---

## Appendix: File References

| Area | Key Files |
|------|-----------|
| Auth routes | `backend/src/api/auth.routes.ts` |
| Auth service | `backend/src/services/auth.service.ts` |
| Agent routes | `backend/src/api/agents.routes.ts` |
| Agent service | `backend/src/services/agent.service.ts` |
| Agent authz | `backend/src/auth/agent-authz.ts` |
| Operator auth | `backend/src/auth/operator-auth.ts`, `backend/src/auth/session-token.ts` |
| Delegation proof verification | `t3-enclave/src/auth/delegation-credential.ts` |
| Authority claims | `t3-enclave/src/auth/authority-claims.ts` |
| Agent identity | `t3-enclave/src/auth/agent-identity.ts` |
| Matching orchestrator | `backend/src/services/matching-orchestrator.ts` |
| Hidden intent service | `backend/src/services/hidden-intent.service.ts` |
| Settlement service | `backend/src/services/settlement.service.ts` |
| Portfolio service | `backend/src/services/portfolio.service.ts` |
| Sepolia sync | `backend/src/services/sepolia-portfolio-sync.service.ts` |
| App wiring | `backend/src/app.ts` |
| Agent SDK client | `agent-client/src/ghostbroker-client.ts` |
| Agent SDK types | `agent-client/src/types.ts` |
| Delegation proof builder | `agent-client/src/delegation-proof.ts` |
| DB schema | `database/schema.sql` |
| API reference docs | `docs/agent-integration/API_REFERENCE.md` |
