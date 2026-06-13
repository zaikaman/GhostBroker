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

**Status: ✅ Resolved**

The `MatchingOrchestrator` now enforces portfolio balance checks and agent authority limits before calling the TEE match contract. Agent limits are stored on admission and carried through to the pending intent queue for enforcement at matching time.

**What was built:**

| Component | File(s) |
|-----------|---------|
| DB migration — authority limit columns on agents table | `database/migrations/009_add_agent_authority_limits.sql` |
| Agent model — `AgentAuthorityLimits`, `AuthorityLimitsSchema` | `backend/src/models/agent.ts` |
| Admission — limits accepted and persisted via `POST /api/agents/admit` | `backend/src/services/agent.service.ts` |
| PendingIntent — carries `instrumentScope`, `directionScope`, `maxNotional` | `backend/src/models/hidden-intent.ts` |
| HiddenIntentService — looks up agent limits from DB, passes through PendingIntent | `backend/src/services/hidden-intent.service.ts` |
| Pre-match portfolio balance check | `backend/src/services/matching-orchestrator.ts` (`checkBalance`) |
| Pre-match direction scope check | `backend/src/services/matching-orchestrator.ts` (`checkDirectionScope`) |
| Pre-match instrument scope check | `backend/src/services/matching-orchestrator.ts` (`checkInstrumentScope`) |
| Pre-match max notional check | `backend/src/services/matching-orchestrator.ts` (`checkMaxNotional`) |
| Dashboard — expandable limits detail per agent | `frontend/src/components/AgentsPanel.tsx` |

**Enforcement flow:**

1. Agent is admitted with optional `limits` (instrumentScope, directionScope, maxNotional)
2. On intent submission, `HiddenIntentService` looks up stored limits from the agents table
3. Limits are carried through `PendingIntent` to the `MatchingOrchestrator`
4. Before calling `evaluateMatch`, the orchestrator checks:
   - **Balance**: Buyer has enough settlement asset (quantity × price), seller has enough of the asset
   - **Direction**: Buy agent is authorized to buy, sell agent is authorized to sell
   - **Instrument**: Agent is authorized to trade the asset code
   - **Notional**: Trade value does not exceed the agent's maxNotional
5. If any check fails, a telemetry error is published to the failing institution and the match is skipped

**Key design decisions:**

- All checks are non-blocking for the intent submission — failures just skip the match attempt
- Balance check falls back to passing if the portfolio service is unavailable (settlement service has the final check)
- Missing limits (null/undefined) means "no restriction" — all assets, all directions, unlimited notional
- Limits are visible in the Agents Panel via click-to-expand detail rows

---

### Gap 3: No Agent Key Management Infrastructure

**Status: ✅ Resolved (Agent Management Panel)**

With API keys (Gap 1) replacing DID challenge-response for agent auth, and agent DB tracking (Gap 4) providing persistent storage, Gap 3 shifted focus to an Agent Management Panel that connects these systems.

**What was built:**

| Component | File(s) |
|-----------|---------|
| Agent Management Panel (Dashboard UI) | `frontend/src/components/AgentsPanel.tsx` |
| `GET /api/agents/:id` — Single agent details | `backend/src/api/agents.routes.ts` |
| `PATCH /api/agents/:id` — Update agent label | `backend/src/api/agents.routes.ts` |
| `AgentService.getAgent()` / `updateAgentLabel()` | `backend/src/services/agent.service.ts` |
| `AgentRepository.findById()` / `updateLabel()` | `backend/src/services/agent-repository.ts` |
| Frontend API methods | `frontend/src/services/api-client.ts` (`getAgent`, `updateAgentLabel`) |

**Key design decisions:**

- Agents panel lives in the Enclaves/Agents tab alongside the connection grid
- Inline label editing with Enter to save / Escape to cancel
- Revoke with confirmation dialog — cascades to clear active intents
- Shows status badges (ADMITTED / REVOKED) with full agent DIDs and registration dates
- API key count summary links to the Developer Keys tab for full management
- All new routes are institution-scoped via `operatorAuth.institutionId`

---

### Gap 4: No Admitted-Agent Tracking in the Database

**Status: ✅ Resolved**

Agents are now persisted to the database on admission. The `agents` table tracks every admission with status (admitted/revoked), authority reference, and timestamps.

**What was built:**

| Component | File(s) |
|-----------|---------|
| `agents` DB table | `database/migrations/008_create_agents.sql` |
| `POST /api/agents/admit` — Now persists admission to DB | `backend/src/services/agent.service.ts` |
| `GET /api/agents` — List admitted agents for institution | `backend/src/api/agents.routes.ts` |
| `POST /api/agents/:id/revoke` — Revoke agent admission | `backend/src/api/agents.routes.ts` |
| Revocation cascade — Clears active intents | `backend/src/services/matching-orchestrator.ts` (`removeIntentsByAgent`) |
| Supabase agent repository | `backend/src/services/agent-repository.ts` |
| In-memory fake repository for tests | `backend/src/tests/data/fake-agent-repository.ts` |
| Frontend API client methods | `frontend/src/services/api-client.ts` (`listAgents`, `revokeAgent`) |

**Key design decisions:**

- Admitted agents get an auto-generated UUID `id` returned in the admission response
- The `institution_id + agent_did` pair is unique (one admission per agent per institution)
- Revoking an agent also clears their pending intents from the matching orchestrator queue
- The `listAgents` endpoint supports an optional `status` query parameter filter
- Auto-updating `updated_at` via a database trigger

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

**Status: 🟡 Partially Resolved**

| Missing Endpoint | Status |
|------------------|--------|
| `GET /api/agents` | ✅ Resolved (part of Gap 4) |
| `POST /api/agents/:id/revoke` | ✅ Resolved (part of Gap 4) |
| `GET /api/agents/intents` | ❌ Still missing |
| `POST /api/agents/intents/cancel` | ❌ Still missing (Gap 5) |
| `GET /api/keys` | ✅ Resolved (part of Gap 1) |
| `POST /api/keys` | ✅ Resolved (part of Gap 1) |
| `POST /api/keys/:id/revoke` | ✅ Resolved (part of Gap 1) |

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
| 2 - Agent-to-Asset Authorization | ✅ Resolved | Gap 4 (agent DB) |
| 3 - Agent Key Management | ✅ Resolved | Gap 4 (agent DB) |
| 4 - Agent DB & Admitted Tracking | ✅ Resolved | Nothing |
| 5 - Intent Cancellation | 🟡 High | Gap 4 (agent DB) |
| 6 - Missing API Endpoints | 🟡 Partially Resolved | Gap 4 (agent DB) |
| 7 - Institution-Scoped Portfolio | 🟡 Medium | Gap 4 (agent DB) |

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
