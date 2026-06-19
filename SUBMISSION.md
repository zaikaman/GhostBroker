# GhostBroker - Terminal 3 Bounty Submission

**Track**: Best implementation of the Terminal 3 Agent Auth SDK
**Bounty**: Terminal 3 Agent Dev Kit ($2,000 cash + $3,000 Google Cloud credits)
**Submission date**: 14 June 2026 (architecture updated 19 June 2026 to match the post-Phase 1 codebase)

---

## What we built

GhostBroker is an institutional dark pool where autonomous trading agents submit buy/sell intents that are matched and settled **without any counterparty ever seeing another counterparty's parameters**. Active order data lives only inside the Terminal 3 TEE; the dashboard, the API, the database, and the WebSocket telemetry stream see only opaque handles, sanitized state labels, and completed trade records. Agents are admitted and authorized via the Ghostbroker-style W3C Verifiable Credential that the Terminal 3 Agent Auth surface mints; humans operate a read-only Observatory Console to monitor connectivity and review completed history with encrypted audit receipts.

The repository is a six-workspace monorepo plus two reference packages:

- `frontend/` - Vite + React dashboard (Vercel target)
- `backend/` - Express + WebSocket API (Heroku target) and Supabase access
- `database/` - Supabase migrations, RLS, and development seed
- `t3-enclave/` - Terminal 3 ADK boundary: ADK sessions, DID registry, Ghostbroker delegation VC verifier, blind-intent client, match-contract client, settlement command builder
- `agent-client/` - the published Node.js TypeScript SDK consumed by external agents and the hosted negotiator (`@ghostbroker/agent-client`)
- `agents/` - hosted multi-provider LLM negotiator agents (Gemini + OpenAI + Groq chain) and the deterministic `guarded-protocol` action choreography
- `negotiation-core/` - shared strategy / turn-context / decision-validation math consumed by both the backend orchestrator and the hosted runtime
- `ghostbroker-delegation-reference/` - the reference procurement-agent BUIDL that ships alongside GhostBroker as a worked example of a Terminal 3 delegated-agent pattern

## Hackathon story: institutional agents on a mandate rail

The hosted demo runs two institutional LLM agents that negotiate **inside** a verifiable authority protocol, not in a free-form LLM-vs-LLM chat:

- Each agent is minted a Terminal 3 DID at admit, the dashboard signs and persists a Ghostbroker delegation W3C VC server-side, and the agent's settlement capacity is pre-cleared through the institution's deposit relayer before the hosted process starts.
- The orchestrator owns the price band, the concession budget, the disclosure gate, the escalation gate, and the settlement command; the LLM owns strategy - opening price, rationale, confidence - **inside** those rails.
- The agent loop defaults to `protocolMode: "llm_freeform"`. The LLM owns every action decision and the loop forwards its decision verbatim. The `guarded_fast` mode (`agents/src/guarded-protocol.ts`) is available as an alternative - it uses a deterministic action choreography where the opening turn always proposes, the only claim exchanged at runtime is `accredited_institution`, `settlement_capacity` is never requested round-by-round, and the post-submit delay is reduced to a short tick.

What the operator sees in the log: agent DID boot, settlement pre-clear, ticket sealed, at least one LLM decision (rationale visible), disclosure verified, accept, settled trade ref. What they do **not** see: free-form disclosure deadlock loops, repeated asks for `settlement_capacity`, or per-round reconciliation of settlement readiness - those facts are pre-launch guarantees, not negotiated claims.

## Terminal 3 Agent Auth SDK integration

The headline integration is the per-action authority verifier in
[`t3-enclave/src/auth/ghostbroker-delegation.ts`](../t3-enclave/src/auth/ghostbroker-delegation.ts).
It verifies Ghostbroker-style W3C Verifiable Credentials end-to-end:

- **Shape + time window + DID binding**: every VC must have an `id`, `issuer`, `credentialSubject.agentDid`, `issuanceDate`/`expirationDate`, and a `proof` object. The verifier checks all of these.
- **Agent-binding**: the credential's `credentialSubject.agentDid` must match the agent DID on the request.
- **Revocation**: the verifier accepts a `revokedAuthorityRefs` set, sourced from `AuthorityRevocationRepository` before every check. Revoked references are rejected as `revoked`.
- **Cryptographic verification** (live mode only): the verifier calls `@terminal3/verify_vc` at runtime if it's installed. Otherwise it falls back to `structural` checks (unless `VC_VERIFY_STRICT=true`).
- **Authority reference**: every verification produces a `ghostbroker-delegation:<vc-id>` reference; the agent must echo this back on every privileged action, and the backend re-asserts equality on each call.

The verifier runs in three modes controlled by the server-side `T3_MODE` env var (with `VC_VERIFY_MODE` kept as a backward-compat alias): `sandbox` (shape + time + DID binding, no crypto), `structural` (the same checks recorded with `verificationMode: "structural"`), and `live` (real `EcdsaSecp256k1Signature2019` JWS verification via `@terminal3/verify_vc`, falling back to `structural` if the SDK call fails and `VC_VERIFY_STRICT=true` is not set). The `setup:identity` + `setup:delegation` flow now produces a real signed JWS by default, so `live` is the production target.

The same facade is used by **every** backend service that performs a privileged action. In the post-Phase 1 architecture, the agent no longer sends the VC on every privileged call - the backend owns the persisted VC. The composition root in [`backend/src/app.ts`](../backend/src/app.ts) constructs `T3AgentAuthorizationFacade` from [`backend/src/auth/agent-authz.ts`](../backend/src/auth/agent-authz.ts) with two entry points:

- **`verifyAgentAuthority(request)`** - the legacy admit-time path. `AgentService.admitAgent` calls this on the very first admission when the agent sends the VC inline; from admit on, the VC is persisted on the `agents` row.
- **`loadAndVerify(input)`** - the post-Phase 1 server-side path. The orchestrator looks up the persisted VC for `(agentId, institutionId)` and runs the same verifier against it on every subsequent privileged action: `submitIntent`, `cancelIntent`, `settlement.execute`, `negotiation.move`, `negotiation.disclose`, `negotiation.settle`.

The same `verifyGhostbrokerDelegationCredential` function is the only verifier behind both entry points. There is no second code path - the backend re-asserts on every privileged call, and the `authorityRef` echo guarantees the agent is presenting the same credential it was admitted with.

The verifier has its own test file at [`t3-enclave/src/tests/auth-agent-client.test.ts`](../t3-enclave/src/tests/auth-agent-client.test.ts) (valid VC, stable sha256 `policyHash`, stale `authorityRef` rejected as `over_scoped`, expired credential rejected as `expired`) and the orchestrator's load-and-verify path is exercised by the `negotiation-orchestrator` and `hosted-demo-settlement` integration suites.

## Two-tier auth architecture

The auth model is layered to match the Agent Auth SDK's design intent:

| Layer | Credential | Consumer | Purpose |
|---|---|---|---|
| **Session** | `gbk_...` persistent API key exchanged for an 8-hour JWT | External agent SDK + hosted negotiator | Authenticate the agent to the backend across reconnects, restarts, and long-running deploys |
| **Authority** | Ghostbroker delegation W3C Verifiable Credential (`ghostbroker-delegation:<vc-id>`) | Every privileged action via `loadAndVerify` on the backend | Authorize *this specific* action against institution policy, with shape, time-window, DID-binding, and revocation checks |

The two are complementary, not alternatives. The API key answers *"which institution does this agent belong to?"*; the delegation VC answers *"is this agent authorized to do this right now, for this action, against this policy?"* This is the same separation the Terminal 3 docs use for the [seed API key pattern](https://docs.terminal3.io/developers/adk/tips/seed-api-key), applied to the agent side of the boundary. Agents exchange the key at `POST /api/auth/api-key`, then the backend loads and verifies the persisted VC on every privileged call.

For the human operator, the dashboard uses a Terminal 3 DID challenge-response flow (`/api/auth/challenge` + `/api/auth/verify`) backed by `T3AgentIdentityVerifier`. The SDK is the agent path; the wallet is the operator path. They solve different problems and live in different surfaces.

## Privacy boundary

Active hidden intent parameters (asset, side, quantity, price, counterparty, queue rank, match score) **never** appear in:

- REST responses to the dashboard or agent
- WebSocket telemetry events (enforced by an allowlist in
  [`backend/src/websocket/redact-event.ts`](../backend/src/websocket/redact-event.ts))
- Supabase rows (the schema stores only institution metadata, encrypted
  receipt payloads, encrypted intent-lock references, and non-sensitive
  operational references - see
  [`database/schema.sql`](../database/schema.sql))
- Server logs (the `redact-event` test fixtures assert this for every
  field on the deny list)

What an operator sees in the Observatory Console is restricted to:

- Connection status (backend, WebSocket, Supabase, T3 sandbox, per-agent)
- Sanitized state transitions: `agent_verified`, `intent_sealed`,
  `encrypted_evaluation`, `settlement_finalized`, `receipt_available`
- Completed trade records (post-settlement only, with encrypted fields)
- Audit receipt metadata (hash, key version, attestation reference)

The privacy boundary is enforced at three layers:

1. **Zod schema** at `POST /api/agents/intents` rejects plaintext `asset`, `side`, `quantity`, or `price` fields with `validation_failed` before the request reaches the orchestrator.
2. **WebSocket allowlist** in `redact-event.ts` drops any event payload carrying forbidden fields - the redaction is tested for every field on the deny list.
3. **Database schema** stores `asset_code_ciphertext`, `quantity_ciphertext`, `execution_price_ciphertext` as opaque ciphertext columns; the corresponding plaintext never crosses the Supabase boundary.

## Settlement rails (WS1 to WS5)

GhostBroker ships a pluggable **settlement rail** layer that
moves the actual assets when a match settles. The layer is
defined in `.hermes/plans/settlement-rails.md` and the
operator-facing runbook lives at
[`docs/settlement-rails.md`](../docs/settlement-rails.md). The
rails we shipped:

- **`wallet:default`** - the noop rail. The DB row is the
  only artifact. Default for the demo "Spin up demo agents"
  flow.
- **`chain:sepolia:erc20`** - the on-chain rail. A real
  `GhostBrokerSettlementRelayer` Solidity contract
  ([`contracts/relayer/`](../contracts/relayer/)) holds the
  per-institution pre-approved ERC-20 allowances and broadcasts
  the atomic `settle(...)` call. The Anvil integration test
  deploys the relayer + 2 minimal ERC-20s + funds + approves
  the relayer, then dispatches a real trade, decodes the
  on-chain `Settled` event, and asserts the ERC-20 `Transfer`
  balances round-trip exactly. The integration test is gated
  by `WS2_ANVIL_INTEGRATION=1`.
- **Production relayer-in-TEE** - the relayer key is held in
  the backend's env for v1; the T3 tenant TEE swap is the
  one-file production migration tracked in the
  [T3 doc-gaps addendum](../docs/terminal3-adk-onboarding-doc-gaps.md)
  (2026-06-15).

The chain rail preserves the dark-pool privacy claim
end-to-end through settlement: the on-chain calldata carries
the relayer's `settle(bytes32, bytes32, address, address,
address, address, uint256, uint256)` ABI; a public chain
observer sees the institution's deposit addresses and the
two `amount` values but **not** the TEE-decrypted `quantity *
price` semantics. The reverser endpoint
(`POST /api/admin/trades/:tradeRef/reverse`) is the only path
that can flip a settled row's `settlement_status`. The
reconciler (system task) is read-only and surfaces drift via a
high-severity `rail_drift_detected` telemetry event.

## What you can run

- `npm install` at the repo root sets up all six workspaces.
- `npm run typecheck` runs `tsc` against every workspace.
- `npm test` runs the Vitest suite for every workspace: **554 tests passing across 104 test files** (1 file / 8 tests skipped by default and gated behind `WS2_ANVIL_INTEGRATION=1` - see the next bullet).
- `WS2_ANVIL_INTEGRATION=1 npm test` adds **8 real on-chain
  tests** that deploy a `GhostBrokerSettlementRelayer`
  contract + 2 ERC-20s to a local Anvil node and assert
  real `Settled` event decoding + `Transfer` balance
  round-trips.
- `npm run sandbox:check --workspace @ghostbroker/t3-enclave` probes the
  live Terminal 3 sandbox and reports the tenant DID + token balance.
- `npm run dev --workspace @ghostbroker/backend` (with `.env` filled in
  from the templates) starts the API; `npm run dev --workspace
  @ghostbroker/frontend` starts the dashboard.

Per-workspace breakdown (defaults, without `WS2_ANVIL_INTEGRATION=1`):

| Workspace | Test files | Tests passing | Tests skipped |
|---|---|---|---|
| `negotiation-core` | 1 | 27 | 0 |
| `t3-enclave` | 12 | 79 | 0 |
| `backend` | 57 | 194 | 8 (chain-sepolia, gated) |
| `frontend` | 17 | 72 | 0 |
| `agent-client` | 9 | 56 | 0 |
| `agents` | 8 | 126 | 0 |
| **Total** | **104** | **554** | **8** |

The full agent developer experience - claim your API key, deploy an
agent, submit intents, watch settlements - is documented in
[`docs/agent-integration/`](../docs/agent-integration/) and walked through
end-to-end in the
[`AgentDeploymentGuide`](../frontend/src/components/AgentDeploymentGuide.tsx)
component of the dashboard itself. The settlement-rail layer
is documented separately in
[`docs/settlement-rails.md`](../docs/settlement-rails.md).

## Bugs and documentation gaps filed

Per the bounty criteria, the Terminal 3 ADK documentation gaps and
onboarding friction points we encountered are tracked in
[`docs/terminal3-adk-onboarding-doc-gaps.md`](../docs/terminal3-adk-onboarding-doc-gaps.md).
The largest classes of friction we hit:

- **Programmatic AI agent delegation is undocumented.** The T3N Dashboard delegation flow is documented; the SDK/API surface for the same operation is not. The post-Phase 1 architecture works around this by making the backend own the persisted VC: the dashboard mints and signs the VC at "Configure Agent" time, persists it on the `agents` row, and re-verifies it on every privileged call via `loadAndVerify`. The agent process never has to mint or send the VC after admit. The `GhostbrokerDelegationAgentAuthClient` class in `t3-enclave/src/auth/agent-auth-client.ts` is now a pure function over the persisted VC; the earlier `POST /agent-delegations/verify` live-network fallback has been removed because the in-memory VC is the only credential the system relies on end-to-end.
- **`agent-auth` Host API is marked coming soon** in the Host API table. We built against the assumption it is *not* available to app contracts and used the documented Dashboard delegation path. Confirming its real status would let us simplify the verifier.
- **Typed error handling is missing.** The ADK returns human-readable detail strings; we have to substring-match in an adapter to map to internal categories (`authority_denied`, `map_acl_denied`, `token_metering_failed`, etc.). Filed for a future typed-SDK release.

## Why we think this submission fits the bounty

- **Agent Auth SDK integration is load-bearing, not cosmetic.** Every privileged backend action goes through the same `T3AgentAuthorizationFacade`. The admit-time path calls `verifyAgentAuthority` on the inline VC; every subsequent privileged action (`submitIntent`, `cancelIntent`, `settlement.execute`, `negotiation.*`) calls `loadAndVerify` on the persisted VC; both paths run the same `verifyGhostbrokerDelegationCredential` function with the same shape, time-window, DID-binding, and revocation checks. There is no "we wrote a wrapper but only call it once" pattern.
- **The architecture matches the SDK's design intent.** The two-tier model (session credential + per-action authority) is the one the Terminal 3 docs describe for the seed-API-key pattern, applied to the agent boundary. The backend-owned, server-side persisted VC is the production-grade realization of the dashboard-delegated authority pattern.
- **The privacy story is enforceable, not aspirational.** Active order parameters never enter the surface; the `redact-event` layer is unit-tested against an explicit deny list; the schema and the API response shapes are all built around the boundary; the `submitIntent` zod schema rejects plaintext `asset`/`side`/`quantity`/`price` before the orchestrator ever sees the request.
- **The code is production-ready and tested.** 554 tests passing across 104 test files; `tsc --noEmit` clean on every workspace; the verifier has its own test file with positive and negative cases; the session and authority layers are independently exercised by `agent-client` and the backend contract tests.