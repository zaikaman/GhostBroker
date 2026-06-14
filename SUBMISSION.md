# GhostBroker — Terminal 3 Bounty Submission

**Track**: Best implementation of the Terminal 3 Agent Auth SDK
**Bounty**: Terminal 3 Agent Dev Kit ($2,000 cash + $3,000 Google Cloud credits)
**Submission date**: 14 June 2026

---

## What we built

GhostBroker is an institutional dark pool where autonomous trading agents submit buy/sell intents that are matched and settled **without any counterparty ever seeing another counterparty's parameters**. Active order data lives only inside the Terminal 3 TEE; the dashboard, the API, the database, and the WebSocket telemetry stream see only opaque handles, sanitized state labels, and completed trade records. Agents are admitted and authorized via the Terminal 3 Agent Auth SDK; humans operate a read-only Observatory Console to monitor connectivity and review completed history with encrypted audit receipts.

The repository is a four-package monorepo:

- `frontend/` — Vite + React dashboard (Vercel target)
- `backend/` — Express + WebSocket API (Heroku target)
- `database/` — Supabase migrations + RLS
- `t3-enclave/` — Terminal 3 ADK boundary, ADK sessions, DID registry, Agent Auth SDK adapter, blind-intent client, match-contract client, settlement command builder

## Terminal 3 Agent Auth SDK integration

The headline integration is the per-action authority verifier in
[`t3-enclave/src/auth/ghostbroker-delegation.ts`](../t3-enclave/src/auth/ghostbroker-delegation.ts).
It verifies Ghostbroker-style W3C Verifiable Credentials end-to-end:

- **Shape + time window + DID binding**: every VC must have an `id`, `issuer`, `credentialSubject.agentDid`, `issuanceDate`/`expirationDate`, and a `proof` object. The verifier checks all of these.
- **Agent-binding**: the credential's `credentialSubject.agentDid` must match the agent DID on the request.
- **Revocation**: the verifier accepts a `revokedAuthorityRefs` set, sourced from `AuthorityRevocationRepository` before every check. Revoked references are rejected as `revoked`.
- **Cryptographic verification** (live mode only): the verifier calls `@terminal3/verify_vc` at runtime if it's installed. Otherwise it falls back to `structural` checks (unless `VC_VERIFY_STRICT=true`).
- **Authority reference**: every verification produces a `ghostbroker-delegation:<vc-id>` reference; the agent must echo this back on every privileged action, and the backend re-asserts equality on each call.

The same facade is used by **every** backend service that performs a privileged action — `AgentService.admitAgent`, `HiddenIntentService.submitIntent`, `HiddenIntentService.cancelIntent`, and `SettlementCommandBuilder.build` — all calling the **same** `T3AgentAuthorizationFacade` singleton with the right `requestedAction` for the action. The VC is persisted on the agent record at admit time, so submit / cancel / settlement re-verify the same credential without the agent having to resend it. See [`backend/src/auth/agent-authz.ts`](../backend/src/auth/agent-authz.ts) and the composition root in [`backend/src/app.ts`](../backend/src/app.ts).

Tests for the verifier live in
[`t3-enclave/src/tests/auth-agent-client.test.ts`](../t3-enclave/src/tests/auth-agent-client.test.ts)
and cover valid VC, stale `authorityRef`, and expired-credential rejection.

## Two-tier auth architecture

The auth model is layered to match the Agent Auth SDK's design intent:

| Layer | Credential | Consumer | Purpose |
|---|---|---|---|
| **Session** | `gbk_…` persistent API key → 8-hour JWT | External agent SDK | Authenticate the agent to the backend across reconnects, restarts, and long-running deploys |
| **Authority** | Ghostbroker delegation W3C Verifiable Credential (`ghostbroker-delegation:<vc-id>`) | Every privileged action | Authorize *this specific* action against institution policy, with shape, time-window, DID-binding, and revocation checks |

The two are complementary, not alternatives. The API key answers *"which institution does this agent belong to?"*; the delegation VC answers *"is this agent authorized to do this right now, for this action, against this policy?"* This is the same separation the Terminal 3 docs use for the [seed API key pattern](https://docs.terminal3.io/developers/adk/tips/seed-api-key), applied to the agent side of the boundary. Agents exchange the key at `POST /api/auth/api-key`, then present the signed VC on every privileged call.

For the human operator, the dashboard uses a Terminal 3 DID challenge-response flow (`/api/auth/challenge` + `/api/auth/verify`) backed by `T3AgentIdentityVerifier`. The SDK is the agent path; the wallet is the operator path. They solve different problems and live in different surfaces.

## Privacy boundary

Active hidden intent parameters (asset, side, quantity, price, counterparty, queue rank, match score) **never** appear in:

- REST responses to the dashboard or agent
- WebSocket telemetry events (enforced by an allowlist in
  [`backend/src/websocket/redact-event.ts`](../backend/src/websocket/redact-event.ts))
- Supabase rows (the schema stores only institution metadata, encrypted
  receipt payloads, and non-sensitive operational references — see
  [`database/schema.sql`](../database/schema.sql))
- Server logs (the `redact-event` test fixtures assert this for every
  field on the deny list)

What an operator sees in the Observatory Console is restricted to:

- Connection status (backend, WebSocket, Supabase, T3 sandbox, per-agent)
- Sanitized state transitions: `agent_verified`, `intent_sealed`,
  `encrypted_evaluation`, `settlement_finalized`, `receipt_available`
- Completed trade records (post-settlement only, with encrypted fields)
- Audit receipt metadata (hash, key version, attestation reference)

## What you can run

- `npm install` at the repo root sets up all four workspaces.
- `npm run typecheck` runs `tsc` against every workspace.
- `npm test` runs the Vitest suite for every workspace: **201 tests, 65 test files, all passing**.
- `npm run sandbox:check --workspace @ghostbroker/t3-enclave` probes the
  live Terminal 3 sandbox and reports the tenant DID + token balance.
- `npm run dev --workspace @ghostbroker/backend` (with `.env` filled in
  from the templates) starts the API; `npm run dev --workspace
  @ghostbroker/frontend` starts the dashboard.

The full agent developer experience — claim your API key, deploy an
agent, submit intents, watch settlements — is documented in
[`docs/agent-integration/`](../docs/agent-integration/) and walked through
end-to-end in the
[`AgentDeploymentGuide`](../frontend/src/components/AgentDeploymentGuide.tsx)
component of the dashboard itself.

## Bugs and documentation gaps filed

Per the bounty criteria, the Terminal 3 ADK documentation gaps and
onboarding friction points we encountered are tracked in
[`docs/terminal3-adk-onboarding-doc-gaps.md`](../docs/terminal3-adk-onboarding-doc-gaps.md).
The largest classes of friction we hit:

- **Programmatic AI agent delegation is undocumented.** The T3N Dashboard delegation flow is documented; the SDK/API surface for the same operation is not. We shipped a working `GhostbrokerDelegationAgentAuthClient` (with a live `/agent-delegations/verify` fallback) but it relies on the undocumented endpoint path.
- **`agent-auth` Host API is marked coming soon** in the Host API table. We built against the assumption it is *not* available to app contracts and used the documented Dashboard delegation path. Confirming its real status would let us simplify the verifier.
- **Typed error handling is missing.** The ADK returns human-readable detail strings; we have to substring-match in an adapter to map to internal categories (`authority_denied`, `map_acl_denied`, `token_metering_failed`, etc.). Filed for a future typed-SDK release.

## Why we think this submission fits the bounty

- **Agent Auth SDK integration is load-bearing, not cosmetic.** Every privileged backend action goes through the same `T3AgentAuthorizationFacade`, which calls the local `verifySignedDelegationProof` first and falls back to the live T3N endpoint. There is no "we wrote a wrapper but only call it once" pattern.
- **The architecture matches the SDK's design intent.** The two-tier model (session credential + per-action authority) is the one the Terminal 3 docs describe for the seed-API-key pattern, applied to the agent boundary.
- **The privacy story is enforceable, not aspirational.** Active order parameters never enter the surface; the `redact-event` layer is unit-tested against an explicit deny list; the schema and the API response shapes are all built around the boundary.
- **The code is production-ready and tested.** 201 tests across 65 files; `tsc --noEmit` clean on every workspace; the verifier has its own test file with positive and negative cases; the session and authority layers are independently exercised by `agent-client` and the backend contract tests.
