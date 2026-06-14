# GhostBroker Infrastructure Gaps

> Audit date: 2026-06-13
> Last updated: 2026-06-14 (all seven gaps resolved, lock-refs + orphan janitor added)
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

**Status: ✅ Resolved**

Agents can now cancel a previously submitted intent that is still pending in the matching orchestrator. Cancellation is gated behind the agent's cryptographic authority proof and the orchestrator's intrinsic ownership check on the `(intentHandle, agentDid, institutionId)` triple.

**What was built:**

| Component | File(s) |
|-----------|---------|
| `MatchingOrchestrator.cancelIntent` (ownership-checked, lock-aware) | `backend/src/services/matching-orchestrator.ts` |
| `HiddenIntentService.cancelIntent` (re-verifies authority, releases lock) | `backend/src/services/hidden-intent.service.ts` |
| `cancelIntentRequestSchema`, `IntentCancelled` view type | `backend/src/models/hidden-intent.ts` |
| `POST /api/agents/intents/cancel` route | `backend/src/api/agents.routes.ts` |
| Integration tests (5) | `backend/src/tests/integration/intent-cancellation.test.ts` |
| Contract tests (4) | `backend/src/tests/contracts/agents-intents-cancel.contract.test.ts` |

**Cancellation flow:**

1. Agent submits `POST /api/agents/intents/cancel` with `{institutionId, agentDid, intentHandle, authorityRef}`
2. `HiddenIntentService` re-verifies the agent's authority proof against the cryptographic verifier
3. Service calls `orchestrator.cancelIntent({intentHandle, agentDid, institutionId})` — the orchestrator's ownership check ensures one agent cannot cancel another's intent
4. On success, the orchestrator removes the intent from the in-memory queue, releases the balance lock (see Gap 7), and emits a telemetry `intent_cancelled` event
5. Service returns `200 { intentHandle, state: "intent_cancelled" }` to the agent

**Key design decisions:**

- Cancellation is **agent-initiated**, not operator-initiated. Operators who need to invalidate an agent's pending intents use `POST /api/agents/:id/revoke`, which cascades through `MatchingOrchestrator.removeIntentsByAgent`.
- The orchestrator's in-memory queue is the single source of truth for "is this intent still pending?" — cancellation of a settled/expired/unknown handle returns 404.
- Cryptographic authority re-verification catches the case where the agent's delegation was revoked after submission.
- The cancel does **not** reverse a settled trade — settlement is terminal.
- The TEE seal on the original intent is not unwound; the cancel only removes the in-memory queue entry and releases the balance lock.

---

### Gap 6: Missing Agent-Related API Endpoints

**Status: ✅ Resolved**

All four originally-missing endpoints are now implemented.

| Missing Endpoint | Status |
|------------------|--------|
| `GET /api/agents` | ✅ Resolved (part of Gap 4) |
| `POST /api/agents/:id/revoke` | ✅ Resolved (part of Gap 4) |
| `GET /api/agents/intents` | ✅ Resolved (new in this work) |
| `POST /api/agents/intents/cancel` | ✅ Resolved (new — see Gap 5) |
| `GET /api/keys` | ✅ Resolved (part of Gap 1) |
| `POST /api/keys` | ✅ Resolved (part of Gap 1) |
| `POST /api/keys/:id/revoke` | ✅ Resolved (part of Gap 1) |

**What was built for `GET /api/agents/intents`:**

| Component | File(s) |
|-----------|---------|
| `MatchingOrchestrator.listPendingIntents` | `backend/src/services/matching-orchestrator.ts` |
| `HiddenIntentService.listPendingIntents` (interface + impl) | `backend/src/services/hidden-intent.service.ts` |
| `GET /api/agents/intents` route (with `?agentDid=` filter) | `backend/src/api/agents.routes.ts` |
| `PendingIntentView` (strips encrypted envelope, authority ref, authority limits) | `backend/src/api/agents.routes.ts` |
| Contract tests (6) | `backend/src/tests/contracts/agents-intents-list.contract.test.ts` |

**Response shape (200):**

```json
{
  "intents": [
    {
      "intentHandle": "intent_abc",
      "correlationRef": "corr_...",
      "agentDid": "did:t3n:0x...",
      "assetCode": "WBTC",
      "side": "buy",
      "quantity": 100,
      "price": 45000,
      "sealedAt": "2026-06-12T00:00:00.000Z"
    }
  ]
}
```

**Key design decisions:**

- Route is declared *before* `GET /agents/:id` in the router so Express does not match `intents` against the `:id` UUID param and 400 on it.
- The view mapper explicitly strips the encrypted envelope, the authority reference, the execution reference, and the authority limits. These are private to the matching engine; leaking them through the API could expose authorization policies.
- The list is always institution-scoped (via `operatorAuth.institutionId`), never cross-institution.
- The optional `?agentDid=` filter is forwarded to the orchestrator's filter. No other query parameters are accepted.

---

### Gap 7: Portfolio Is Institution-Scoped, Not Agent-Scoped

**Status: ✅ Resolved**

The portfolio layer now supports per-agent balance reservations and an agent-level portfolio view, addressing both the over-commitment risk and the visibility gap.

**What was built:**

| Component | File(s) |
|-----------|---------|
| `portfolio_lock_balance` SQL RPC (atomic lock, `SELECT ... FOR UPDATE`) | `database/migrations/010_portfolio_lock_release.sql` |
| `portfolio_release_balance` SQL RPC (idempotent, clamped at zero) | `database/migrations/010_portfolio_lock_release.sql` |
| `intent_locks` SQL table (per-intent refs for orphan recovery) | `database/migrations/011_create_intent_locks.sql` |
| `IntentLockRecord` / `IntentLock` model types | `backend/src/models/intent-lock.ts` |
| `PortfolioService.lockBalance` (throws `InsufficientBalanceError` on insufficient available balance) | `backend/src/services/portfolio.service.ts` |
| `PortfolioService.releaseBalance` (best-effort, never throws) | `backend/src/services/portfolio.service.ts` |
| `MatchingOrchestrator.lockDescriptorFor` (public; defines lock formula) | `backend/src/services/matching-orchestrator.ts` |
| `MatchingOrchestrator.checkBalance` updated to use **available** (balance - locked) | `backend/src/services/matching-orchestrator.ts` |
| `HiddenIntentService.submitIntent` acquires the lock after TEE seal, before pushing to orchestrator | `backend/src/services/hidden-intent.service.ts` |
| `MatchingOrchestrator.cancelIntent / removeIntentsByAgent / evictExpired` release the lock for each removed intent | `backend/src/services/matching-orchestrator.ts` |
| `IntentLockRepository` (Supabase + in-memory test impl) — durable refs to every active lock | `backend/src/services/intent-lock-repository.ts` |
| `HiddenIntentService` writes a lock ref on submit, deletes on cancel | `backend/src/services/hidden-intent.service.ts` |
| `MatchingOrchestrator.deleteLockRefFor` (private helper) called alongside `releaseLockFor` on every eviction path | `backend/src/services/matching-orchestrator.ts` |
| Pre-match-failure paths (balance / direction / instrument / notional) release the counterparty's lock + ref before splicing | `backend/src/services/matching-orchestrator.ts` |
| `IntentLockJanitor` (sweeper) — every 30s, finds refs older than the intent TTL and releases them | `backend/src/services/intent-lock-janitor.ts` |
| `intent_lock_released` telemetry phase added to the backend and agent-client type unions | `backend/src/websocket/telemetry-event.ts`, `agent-client/src/types.ts` |
| `InsufficientBalanceError` mapped to 403 in the submit route | `backend/src/api/agents.routes.ts` |
| Agent-level view in `GET /api/portfolios/:institutionId?agentDid=...` | `backend/src/api/portfolios.routes.ts` |
| `matchingOrchestrator`, `intentLockRepository`, `intentLockJanitor` exposed via `BackendServices` | `backend/src/app.ts` |
| Unit tests for lock/release (6) | `backend/src/tests/unit/portfolio-service.test.ts` |
| Unit tests for in-memory lock client (8) | `backend/src/tests/unit/intent-lock-repository.test.ts` |
| Integration tests for orchestrator lock lifecycle (6) + settlement implicit release (1) + pre-match-failure release (1) | `backend/src/tests/integration/matching-orchestrator-reservation.test.ts` |
| Integration tests for the orphan-lock janitor (7) | `backend/src/tests/integration/intent-lock-janitor.test.ts` |
| Integration tests for restart safety (3) — submit, restart, sweeper recovers | `backend/src/tests/integration/intent-lock-restart-safety.test.ts` |
| Contract tests for agent-level portfolio view (5) | `backend/src/tests/contracts/portfolios-agent.contract.test.ts` |
| In-memory test client extended with `portfolio_lock_balance` and `portfolio_release_balance` RPCs | `backend/src/tests/support/in-memory-portfolio-client.ts` |
| In-memory test client for the `intent_locks` table (with `seed()` helper for restart-safety tests) | `backend/src/tests/support/in-memory-intent-lock-client.ts` |

**Lock lifecycle:**

1. **Acquire (submit):** After the TEE seals the intent, `HiddenIntentService.submitIntent` calls `portfolioService.lockBalance(institutionId, assetCode, amount)`. The amount is `quantity * price` of the settlement asset for buys, or `quantity` of the traded asset for sells. If the institution's available balance is insufficient, the lock RPC raises, the service throws `InsufficientBalanceError`, and the route returns 403 `authorization_failed` (redacted — the agent does not learn the institution's exact balance). On success, a row is also inserted into `intent_locks` keyed by the TEE-assigned `intent_handle`, so the janitor can recover from process restarts.

2. **Release on cancel:** `MatchingOrchestrator.cancelIntent` releases the lock for the removed intent and deletes the corresponding `intent_locks` row. The service's `cancelIntent` simply calls into the orchestrator and surfaces the result.

3. **Release on revocation:** `MatchingOrchestrator.removeIntentsByAgent` (called from `AgentService.revokeAgent`) releases the lock for each removed intent and deletes each ref row.

4. **Release on TTL expiry:** `MatchingOrchestrator.evictExpired` releases the lock for each evicted intent and deletes each ref row, on its 30-second sweep.

5. **Release on settlement (implicit):** Settlement's `portfolioService.applySettlement` calls `portfolio_update_balance` for each leg. The SQL function clamps `locked = LEAST(locked, new_balance)`, so as the balance drains the lock is reduced automatically. The orchestrator's match-success path explicitly deletes the `intent_locks` rows for both matched intents before splicing them from the queue, so the janitor does not see them.

6. **Release on pre-match failure:** When the orchestrator's `checkBalance` / `checkDirectionScope` / `checkInstrumentScope` / `checkMaxNotional` returns a failure, the orchestrator splices the counterparty (`other` in the matching loop) from the queue and calls `releaseLockFor(other)` + `deleteLockRefFor(other)`. The new intent (`intent`) stays in the queue and keeps its lock, because it may still match against a different counterparty.

7. **Release on orphan recovery (process restart):** The `IntentLockJanitor` runs every 30 seconds and queries `intent_locks WHERE created_at < now() - intent_ttl`. For each row, it calls `portfolioService.releaseBalance(institutionId, assetCode, amount)` (the `portfolios.locked` is decremented; if the lock amount was already drained by settlement, the SQL `LEAST` clamp makes this a no-op) and then deletes the row. This recovers stranded locks when the in-memory orchestrator queue is lost across a process restart. The janitor's interval is `.unref()`'d so it never blocks process exit.

**Policy decision (pre-match-failure lock release):** When a pre-match check fails between two pending intents, the orchestrator's matching loop splices the *existing* intent in the queue (the `other` variable) and releases that side's lock. The just-arrived intent (`intent`) keeps its lock, since the *new* intent can still try to match against a *different* counterparty. This policy is enforced uniformly across all four pre-match checks and is covered by `matching-orchestrator-reservation.test.ts`.

**Agent-level view (`GET /api/portfolios/:institutionId?agentDid=...`):**

When the `agentDid` query parameter is present, the route returns a DB-only view (no wallet sync, since the agent does not own the wallet) augmented with the agent's pending reservations:

```json
{
  "institutionId": "00000000-0000-4000-8000-000000000101",
  "agentDid": "did:t3n:0xAgentAddress",
  "holdings": [
    { "assetCode": "USDC", "balance": 1000000, "locked": 100000 },
    { "assetCode": "WBTC", "balance": 5, "locked": 0 }
  ],
  "pendingReservations": [
    {
      "intentHandle": "intent_buy_1",
      "assetCode": "USDC",
      "amount": 100000,
      "side": "buy",
      "quantity": 2,
      "price": 50000
    }
  ]
}
```

The `available` balance for any asset is `balance - locked` (the `locked` field is already exposed in the standard holdings shape; the route does not duplicate it). When `agentDid` is absent, the route's behavior is unchanged from before this work (wallet sync or DB fallback).

**Key design decisions:**

- **No new table.** The lock uses the existing `portfolios.locked` column, which was already constrained `locked <= balance`. The `portfolio_update_balance` SQL function already auto-clamps on every delta, so settlement naturally releases the lock as it drains balance. Adding a new table would have been a much larger blast radius.
- **Lock before queue push.** The lock is acquired in `HiddenIntentService.submitIntent` *before* the orchestrator's `onIntentSealed` is fired, so a lock failure surfaces to the agent as a clean 403 *before* the HTTP 202 is sent. This is preferable to the alternative (fire-and-forget lock inside the orchestrator) where an agent could see a 202 success even though the intent was not actually queued.
- **Release is best-effort.** The orchestrator's release paths call `portfolioService.releaseBalance` via `void` and log errors internally. The in-memory queue mutation is unaffected by transient DB failures — locks are eventually consistent.
- **Insufficient available balance is 403, not 400.** The agent is told they are not authorized to commit the institution's balance, without learning the exact balance. This matches the privacy posture of the rest of the system.
- **Transient DB errors during lock acquisition are non-blocking.** If `lockBalance` throws anything other than `InsufficientBalanceError`, the service logs and continues. The orchestrator's `checkBalance` and the settlement service re-validate balances before any money moves, so a missed lock does not result in over-commitment.

**Known limitations:**

- **The orchestrator is in-memory.** A process restart still loses the in-memory `pendingIntents` queue. The lock-refs table + janitor are the recovery path: a fresh process picks up the `intent_locks` rows, finds nothing in the in-memory queue, and after the intent TTL elapses the janitor releases the corresponding `portfolios.locked` amounts. The TTL is 5 minutes; a process restart means up to 5 minutes of "we have a lock in the DB but no in-memory owner." This is the same latency the in-memory orchestrator had before reservations were added — the lock just makes it observable, not worse. The right longer-term fix is to make the orchestrator's queue durable (e.g., backed by Supabase), at which point the janitor becomes unnecessary. Out of scope for this work.

- **The orchestrator's matching loop is single-process.** The in-memory queue and the `setInterval` eviction are scoped to a single Node.js process. A horizontally-scaled deployment would need a shared queue (e.g., Supabase-backed), which is the same durable-orchestrator fix mentioned above.

- **TEE-sealed-but-never-queued intents leave a stranded lock for up to the intent TTL.** If the TEE seal succeeds but the service crashes (or the orchestrator's `onIntentSealed` fails catastrophically) before the intent enters the queue, the `intent_locks` row is orphaned from the moment of submit. The janitor releases it after 5 minutes. Acceptable for now; a tighter recovery would require a Supabase-backed queue (see above).

- **No idempotency on `cancel`.** A duplicate `cancel` request for the same `intentHandle` returns 404 the second time (the orchestrator's queue no longer has the intent). The HTTP layer does not deduplicate, so an agent that retries after a network blip will see a 404. This is intentional — the cancel succeeded; the 404 is a confirmation, not an error — but it is worth noting for client retry logic.

- **The janitor and orchestrator cleanup timers do not block process exit.** Both intervals are `.unref()`'d so the Node.js process can exit even if a sweep is pending. This is correct for the production deployment (where a process supervisor restarts the service), but it means a process that exits cleanly during a sweep window will skip that sweep. The next process startup re-derives the same set of stranded locks from the `intent_locks` table, so no work is lost.

---

## Gap Severity Summary

| Gap | Severity | Depends On |
|-----|----------|------------|
| 1 - API Key System | ✅ Resolved | Nothing |
| 2 - Agent-to-Asset Authorization | ✅ Resolved | Gap 4 (agent DB) |
| 3 - Agent Key Management | ✅ Resolved | Gap 4 (agent DB) |
| 4 - Agent DB & Admitted Tracking | ✅ Resolved | Nothing |
| 5 - Intent Cancellation | ✅ Resolved | Gap 4 (agent DB) |
| 6 - Missing API Endpoints | ✅ Resolved | Gap 4 (agent DB) |
| 7 - Institution-Scoped Portfolio | ✅ Resolved | Gap 4 (agent DB) |

**All seven gaps are resolved.** The platform now has the missing user-facing infrastructure for agents to connect, authenticate, and trade in production: persistent API keys, per-agent authority enforcement, admitted-agent tracking, intent cancellation, list endpoints, and per-agent balance reservations with an agent-level portfolio view.

---

## Recommended Implementation Order

This was the planned order; all items are now ✅ Resolved.

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
| Portfolio lock/release migration | `database/migrations/010_portfolio_lock_release.sql` |
| Intent-locks table migration | `database/migrations/011_create_intent_locks.sql` |
| Intent-locks model | `backend/src/models/intent-lock.ts` |
| Intent-lock repository (Supabase) | `backend/src/services/intent-lock-repository.ts` |
| Intent-lock janitor (sweeper) | `backend/src/services/intent-lock-janitor.ts` |
| API reference docs | `docs/agent-integration/API_REFERENCE.md` |
