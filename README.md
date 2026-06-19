# GhostBroker

### The Attested Enclave for Institutional Dark Pools

GhostBroker is an institutional-grade dark pool built on the Terminal 3
network where autonomous trading agents submit buy and sell intents that
are matched and settled **without any counterparty ever seeing another
counterparty's parameters**. Active order data - assets, sides,
quantities, prices, counterparties, queue position, match score -
never leaves the Terminal 3 TEE. The dashboard, the REST API, the
WebSocket telemetry stream, and the Supabase database see only opaque
handles, sanitized state labels, and post-settlement encrypted records.

The headline integration is a server-side W3C Verifiable Credential
verifier for the Ghostbroker-style agent-delegation VC that the
Terminal 3 Agent Auth surface mints. Every privileged backend action
re-verifies that credential against institution policy, so no agent
can submit an intent, cancel a pending intent, settle a match, or
move a negotiation outside the authority its institution granted.

This is the production code, the tests, the deployment topology, the
runbooks, and the SDK that backs the bounty submission. Everything
in this repository is real code that runs locally and is wired to a
live Terminal 3 sandbox.

---

## Table of contents

- [Why GhostBroker exists](#why-ghostbroker-exists)
- [What GhostBroker does](#what-ghostbroker-does)
- [The privacy promise](#the-privacy-promise)
- [The Terminal 3 Agent Auth SDK integration](#the-terminal-3-agent-auth-sdk-integration)
- [Two-tier authorization model](#two-tier-authorization-model)
- [Architecture](#architecture)
- [Workspace layout](#workspace-layout)
- [Technology stack](#technology-stack)
- [Test coverage and quality bars](#test-coverage-and-quality-bars)
- [Local development setup](#local-development-setup)
- [Environment variables](#environment-variables)
- [Quick start: end to end](#quick-start-end-to-end)
- [REST API tour](#rest-api-tour)
- [WebSocket telemetry tour](#websocket-telemetry-tour)
- [Agent developer tour](#agent-developer-tour)
- [The negotiation loop](#the-negotiation-loop)
- [The LLM provider chain](#the-llm-provider-chain)
- [Privacy enforcement layers](#privacy-enforcement-layers)
- [Settlement rails](#settlement-rails)
- [Database schema](#database-schema)
- [Design system](#design-system)
- [Operational playbooks](#operational-playbooks)
- [Deployment topology](#deployment-topology)
- [Security](#security)
- [Documentation gaps filed against T3](#documentation-gaps-filed-against-t3)
- [Reference workspace](#reference-workspace)
- [Contributing](#contributing)
- [License](#license)

---

## Why GhostBroker exists

Institutional dark pools sit in a strange place in modern finance. The
operator who runs the venue has to know enough about the order flow to
match it, but must never know enough to leak it. The agents that submit
orders have to prove they are authorized to act, but cannot be trusted
with their counterparties' parameters. The human operator who watches
the system has to be able to prove it ran correctly, but cannot be
allowed to see what it ran on.

Most existing implementations solve this with operational discipline:
vaults, NDAs, segregation of duties, four-eyes reviews. GhostBroker
solves it with an attested execution boundary. Active order parameters
never reach a process that could leak them. The Terminal 3 TEE is the
only place where matching and settlement see plaintext, and even there
the TEE contract is the only program that touches them. The
surrounding surfaces - dashboard, REST API, WebSocket, database - see
only the references the TEE chooses to reveal.

The result is a system where a curious operator cannot reconstruct an
order book from telemetry, a leaked database snapshot cannot reconstruct
a position, and a compromised backend process still cannot forge an
intent, because the intent never reaches the backend in the first
place. Every privileged action is gated by the same W3C Verifiable
Credential verifier, and the verifier only sees credentials the
dashboard minted on behalf of the institution.

---

## What GhostBroker does

Concretely, GhostBroker is six cooperating packages plus two reference
packages:

| Package | What it owns | Deployment target |
|---|---|---|
| `frontend/` | Operator observatory: connection status, agent grid, encrypted receipt drawer, completed-trade table, deployment guide | Vercel |
| `backend/` | REST API, WebSocket telemetry, Supabase access, privacy redaction, settlement service, agent service | Heroku |
| `database/` | Supabase PostgreSQL migrations, RLS policies, dev seed | Supabase managed |
| `t3-enclave/` | Terminal 3 ADK boundary: sessions, DID registry, Ghostbroker delegation VC verifier, blind-intent client, match-contract client, settlement command builder | npm package, used by backend |
| `agent-client/` | Published TypeScript SDK for external agents (`@ghostbroker/agent-client`) and the hosted negotiator | npm |
| `agents/` | Hosted multi-provider LLM negotiator agents (Gemini + OpenAI + Groq chain) | Hosted Node.js |
| `negotiation-core/` | Shared strategy / turn-context / decision-validation math consumed by the backend orchestrator and the hosted runtime | npm package |
| `ghostbroker-delegation-reference/` | Reference procurement-agent BUIDL that demonstrates a Terminal 3 delegated-agent pattern end to end | Reference / docs |

The boundary between these packages is also the deployment boundary.
The frontend never imports from `t3-enclave/` and never sees a
plaintext active-order field. The backend owns the Supabase access
and the orchestrator, but calls the T3 enclave through typed services
that return opaque handles. The agents package never imports the T3
ADK directly - the backend mints the delegation VC, persists it
server-side, and re-verifies it on every privileged call.

---

## The privacy promise

GhostBroker's central technical claim is enforceable, not aspirational.
Active hidden intent parameters - the asset, the side, the quantity,
the price, the counterparty, the queue rank, the match score - never
appear in any of these surfaces:

- REST responses to the dashboard or to an agent
- WebSocket telemetry events (enforced by an allowlist in
  `backend/src/websocket/redact-event.ts`)
- Supabase rows (the schema stores only institution metadata, encrypted
  receipt payloads, encrypted intent-lock references, and non-sensitive
  operational references)
- Server logs (the `redact-event` test fixtures assert this for every
  field on the deny list)
- Frontend screenshots, Playwright traces, and test fixtures

The privacy boundary is enforced at four layers:

1. **Zod schema at the intent edge.** `POST /api/agents/intents`
   rejects any plaintext `asset`, `side`, `quantity`, or `price` field
   with `validation_failed` before the request reaches the orchestrator.
   The contract test
   `backend/src/tests/contracts/agents-intents-privacy.contract.test.ts`
   exercises every forbidden field.
2. **WebSocket allowlist.** Every event the backend emits is run
   through `redact-event.ts`, which strips any field on the deny list
   and drops the event if it would otherwise leak a forbidden value.
3. **Database schema.** Active trade columns are stored as ciphertext:
   `asset_code_ciphertext`, `quantity_ciphertext`,
   `execution_price_ciphertext`. The corresponding plaintext never
   crosses the Supabase boundary.
4. **Dashboard tests.** The frontend has a dedicated
   `privacy-redaction.test.tsx` that searches every rendered string
   for forbidden field names and rejects any match. Playwright's
   `dashboard-privacy.spec.ts` does the same at the browser level.

What the operator does see:

- Connection status (backend, WebSocket, Supabase, T3 sandbox, per-agent)
- Sanitized state transitions: `agent_verified`, `intent_sealed`,
  `encrypted_evaluation`, `settlement_finalized`, `receipt_available`
- Completed trade records (post-settlement only, with encrypted fields)
- Audit receipt metadata (hash, key version, attestation reference)
- Encrypted receipt payloads that only the institution can decrypt with
  its own receipt key (held inside the T3 tenant private map)

---

## The Terminal 3 Agent Auth SDK integration

The headline integration is the per-action authority verifier in
[`t3-enclave/src/auth/ghostbroker-delegation.ts`](t3-enclave/src/auth/ghostbroker-delegation.ts).
It verifies Ghostbroker-style W3C Verifiable Credentials
end-to-end. The verifier runs in three modes controlled by the
server-side `T3_MODE` env var (with `VC_VERIFY_MODE` kept as a
backward-compat alias):

- **`sandbox`** - shape + time window + DID binding. No crypto. This
  is the default and the mode the demo "Spin up demo agents" button
  uses. Unsigned demo credentials pass. The `sandbox` mode is also
  the only mode in which an SDK error is tolerated (the demo surface
  keeps the historical "verified on SDK error" behaviour).
- **`structural`** - the same checks, recorded with
  `verificationMode: "structural"`. Used in CI and integration tests.
- **`live`** - real `EcdsaSecp256k1Signature2019` JWS verification
  via `@terminal3/verify_vc`. The verifier **fails closed** on any
  SDK exception: it never silently downgrades to a non-cryptographic
  `structural` pass. Demo markers are rejected as
  `demo_proof_in_live_mode`. The legacy `VC_VERIFY_STRICT=true` opt-in
  is now a no-op (the verifier always fails closed outside `sandbox`).

The verifier checks every VC for:

- **Shape + time window + DID binding.** Every VC must have an `id`,
  `issuer`, `credentialSubject.agentDid` (plus the
  `credentialSubject.allowedActions` trading-agent action scope),
  `issuanceDate`/`expirationDate`, and a `proof` object. The
  verifier checks all of these against the request's `agentDid` and
  `now`.
- **Agent-binding.** The credential's `credentialSubject.agentDid` must
  match the agent DID on the request.
- **Revocation.** The verifier accepts a `revokedAuthorityRefs` set,
  sourced from `AuthorityRevocationRepository` before every check.
  Revoked references are rejected as `revoked`.
- **Cryptographic verification (live mode).** The verifier calls
  `@terminal3/verify_vc` at runtime when the mode is `live`. The
  verifier fails closed on any SDK error — see
  `t3-enclave/src/auth/ghostbroker-delegation.ts`'s `tryLiveVerify`
  for the production-grade contract.
- **Authority reference.** Every verification produces a
  `ghostbroker-delegation:<vc-id>` reference. The agent must echo this
  back on every privileged action, and the backend re-asserts equality
  on each call.

The post-Phase 1 architecture removes the agent-side re-send of the
VC on every call. The backend mints and persists the VC at admit time
and re-verifies it on every subsequent privileged action. The
adapter lives in
[`t3-enclave/src/auth/agent-auth-client.ts`](t3-enclave/src/auth/agent-auth-client.ts);
the facade lives in
[`backend/src/auth/agent-authz.ts`](backend/src/auth/agent-authz.ts)
and exposes two entry points:

- `verifyAgentAuthority(request)` - the admit-time path. Called once
  on the very first admission when the agent sends the VC inline.
  Persists the VC on the `agents` row.
- `loadAndVerify(input)` - the post-Phase 1 server-side path. The
  orchestrator looks up the persisted VC for `(agentId, institutionId)`
  and runs the same verifier against it on every subsequent
  privileged action (`submitIntent`, `cancelIntent`,
  `settlement.execute`, `negotiation.move`, `negotiation.disclose`,
  `negotiation.settle`).

Both entry points funnel into the same `verifyGhostbrokerDelegationCredential`
function. The verifier is the single source of truth for agent
authority.

The verifier has its own test file at
[`t3-enclave/src/tests/auth-agent-client.test.ts`](t3-enclave/src/tests/auth-agent-client.test.ts):
valid VC, stable sha256 `policyHash`, stale `authorityRef` rejected
as `over_scoped`, expired credential rejected as `expired`. The
orchestrator's load-and-verify path is exercised by the
`negotiation-orchestrator` and `hosted-demo-settlement` integration
suites.

---

## Two-tier authorization model

The auth model is layered to match the Agent Auth SDK's design intent:

| Layer | Credential | Consumer | Purpose |
|---|---|---|---|
| **Session** | `gbk_...` persistent API key exchanged for an 8-hour JWT | External agent SDK + hosted negotiator | Authenticate the agent to the backend across reconnects, restarts, and long-running deploys |
| **Authority** | Ghostbroker delegation W3C Verifiable Credential (`ghostbroker-delegation:<vc-id>`) | Every privileged action via `loadAndVerify` on the backend | Authorize this specific action against institution policy, with shape, time-window, DID-binding, and revocation checks |

The two are complementary, not alternatives. The API key answers
*"which institution does this agent belong to?"*; the delegation VC
answers *"is this agent authorized to do this right now, for this
action, against this policy?"* This is the same separation the
Terminal 3 docs use for the [seed API key
pattern](https://docs.terminal3.io/developers/adk/tips/seed-api-key),
applied to the agent side of the boundary. Agents exchange the key
at `POST /api/auth/api-key`, then the backend loads and verifies the
persisted VC on every privileged call.

For the human operator, the dashboard uses a Terminal 3 DID
challenge-response flow (`/api/auth/challenge` + `/api/auth/verify`)
backed by `T3AgentIdentityVerifier`. The SDK is the agent path; the
wallet is the operator path. They solve different problems and live in
different surfaces.

---

## Architecture

```
                 +-------------------------------+
                 |  Operator Browser (Vercel)    |
                 |  React + Vite dashboard       |
                 +---------------+---------------+
                                 |
                          wss:// | REST (filtered)
                                 |
        +------------------------+---------------------------+
        |                                                    |
        |            GhostBroker Backend (Heroku)            |
        |  Express + ws + Zod + privacy redaction            |
        |                                                    |
        |  +---------------+    +-------------------------+ |
        |  | Auth facade   |    | Orchestrator (settlement||
        |  | (loadAndVerify|--- | negotiation, intents)   ||
        |  |  on every     |    +------------+------------+ |
        |  |  action)      |                 |              |
        |  +-------+-------+                 |              |
        |          |                         v              |
        |          |              +----------+-----------+  |
        |          |              |  Supabase PostgreSQL |  |
        |          |              |  encrypted receipts  |  |
        |          |              |  institution meta    |  |
        |          |              +----------------------+  |
        |          v                                         |
        |  +-------+-------------------------------------+ |
        |  | t3-enclave (the ADK boundary)               | |
        |  |  +-----------+   +------------+   +-------+ | |
        |  |  | Ghostbroker|  | Match      |   | T3N   | | |
        |  |  | delegation |  | contract   |   | SDK   | | |
        |  |  | verifier   |  | client     |   |       | | |
        |  |  +-----------+   +------------+   +-------+ | |
        |  +---------------------------------------------+ |
        +------------------------+---------------------------+
                                 |
                                 v
                  +--------------+--------------+
                  |  Terminal 3 TEE Cluster      |
                  |  Encrypted execution,        |
                  |  private tenant KV,          |
                  |  attestations                |
                  +-----------------------------+

  External agents (npm install @ghostbroker/agent-client)
   |                            ^
   | POST /api/auth/api-key     | wss telemetry
   | POST /api/agents/admit     | (sanitized events)
   | POST /api/agents/intents   |
   | GET  /api/trades/completed |
   v
  GhostBroker Backend (above)
```

The terminal-3 boundary is enforced at compile time. `frontend/` never
imports `@ghostbroker/t3-enclave`; `agents/` never imports the T3
ADK directly. The only place the SDK is called from is
`t3-enclave/src/sandbox/t3n-client.ts`, which is the only module that
talks to the Terminal 3 network.

---

## Workspace layout

```
ghostbroker/
|-- package.json                   # npm workspaces root
|-- README.md                      # this file
|-- SUBMISSION.md                  # bounty submission document
|-- DESIGN.md                      # design system: colors, typography, components
|-- PRODUCT.md                     # product positioning, audience, anti-references
|-- terminal3docs.md               # offline reference of Terminal 3 docs
|-- database/                      # Supabase PostgreSQL
|   |-- schema.sql                 # canonical schema (context only)
|   |-- migrations/                # numbered SQL migrations
|   |-- policies/                  # row-level security policies
|   `-- seed/                      # dev seed data
|-- frontend/                      # Vite + React dashboard
|   |-- src/
|   |   |-- app/                   # routes + App
|   |   |-- components/            # observatory surfaces
|   |   |-- hooks/                 # telemetry + trade history hooks
|   |   |-- services/              # api-client + telemetry-client
|   |   |-- styles/                # theme.css + dashboard.css
|   |   `-- test/                  # Vitest + RTL
|   `-- tests/                     # Playwright dashboard + privacy specs
|-- backend/                       # Express REST + WebSocket + Supabase
|   |-- src/
|   |   |-- api/                   # institutions, agents, trades, receipts, portfolios
|   |   |-- auth/                  # operator-auth, agent-authz, api-key-auth, session-token
|   |   |-- services/              # agent, hidden-intent, settlement, portfolio, telemetry
|   |   |-- websocket/             # redact-event + telemetry-server
|   |   |-- privacy/               # forbidden-fields allowlist
|   |   |-- validation/            # zod schemas (encrypted-intent etc.)
|   |   `-- tests/                 # unit + integration + contracts
|   `-- Procfile                   # Heroku process definitions
|-- t3-enclave/                    # Terminal 3 ADK boundary
|   |-- src/
|   |   |-- auth/                  # Ghostbroker delegation VC verifier + agent authz
|   |   |-- keys/                  # key-generation + key-rotation + sealed-secret-maps
|   |   |-- matching/              # blind-intent + match-contract + settlement-command
|   |   |-- negotiation/           # negotiation ticket + disclosure verifier + evaluate-round
|   |   |-- runner/                # ADK runner creation + lifecycle + agent loop
|   |   |-- sandbox/               # T3N client + tenant identity store + token balance
|   |   `-- tests/
|-- agent-client/                  # @ghostbroker/agent-client (published SDK)
|   |-- src/
|   |   |-- auth-client.ts
|   |   |-- delegation-signer.ts
|   |   |-- ghostbroker-client.ts
|   |   |-- intent-client.ts
|   |   |-- negotiation-client.ts
|   |   |-- portfolio-client.ts
|   |   |-- receipt-client.ts
|   |   |-- trades-client.ts
|   |   |-- websocket-client.ts
|   |   `-- errors.ts
|-- agents/                        # hosted LLM negotiator
|   |-- src/
|   |   |-- buyer-agent.ts
|   |   |-- seller-agent.ts
|   |   |-- hosted-agent.ts
|   |   |-- env.ts
|   |   |-- identity.ts
|   |   |-- delegation.ts          # W3C VC schema + load helpers
|   |   |-- vc-verifier.ts
|   |   |-- sealed-envelope.ts
|   |   |-- llm-decision.ts
|   |   |-- negotiation-decision.ts
|   |   |-- run-loop.ts            # shared per-tick loop (buyer/seller)
|   |   |-- negotiation-loop.ts    # shared per-tick loop (hosted)
|   |   `-- llm/                  # Gemini + OpenAI + Groq fallback chain
|-- negotiation-core/              # shared strategy math
|   `-- src/
|       |-- negotiation-strategy.ts
|       `-- index.ts
|-- ghostbroker-delegation-reference/  # reference procurement-agent BUIDL
|   |-- src/
|   |   |-- agent/
|   |   |-- auth/                  # policy-engine + vc-verifier
|   |   |-- audit/
|   |   |-- catalog/
|   |   |-- scripts/
|   |   `-- t3/                    # adk-client + identity + plugin-bridge + setup-maps
|-- contracts/                     # on-chain settlement rail
|   `-- relayer/
|       |-- foundry.toml
|       |-- src/contracts/
|       |   |-- GhostBrokerSettlementRelayer.sol
|       |   `-- MinimalERC20.sol
|       `-- deploy.mjs
|-- docs/                          # operator + developer documentation
|   |-- agent-integration/         # agent developer guide (6 files)
|   |-- deployment/
|   |-- designs/
|   |-- privacy/
|   |-- qa/
|   |-- infrastructure-gaps.md
|   |-- settlement-rails.md
|   `-- terminal3-adk-onboarding-doc-gaps.md
|-- scripts/                       # repo-level scripts
|-- tests/                         # root Playwright specs
`-- .hermes/plans/                 # internal planning documents
```

---

## Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x, strict mode, no `any` | Single language across the repo, contract-level type safety at the T3 boundary |
| Runtime | Node.js 20 LTS | Stable, supports `fetch` + `WebSocket` natively |
| Frontend | React 18 + Vite | Fast HMR, simple production build, small bundle |
| Backend | Express + ws (raw WebSocket) + Zod | Minimal, predictable, Zod gives us typed boundary validation |
| Database | Supabase PostgreSQL | Managed, with RLS for institution isolation |
| Confidential execution | Terminal 3 ADK + T3N TEE | The only place active order parameters are decrypted |
| Crypto verification | `@terminal3/verify_vc` | The live mode verifier for `EcdsaSecp256k1Signature2019` JWS |
| LLM providers | Gemini + OpenAI + Groq with a fallback chain | Provider resilience without lock-in |
| Blockchain (settlement) | Solidity 0.8.x via Foundry, viem for client | Audited, well-known tooling; viem is the modern client |
| Test runner | Vitest | Native ESM, fast, plays well with Vite + TypeScript |
| Browser tests | Playwright | Multi-browser, supports the dashboard privacy scan |
| React tests | React Testing Library | Standard RTL behavior + accessibility assertions |
| Linting | ESLint flat config + Prettier | Enforced repo-wide via root scripts |
| Build | `tsc` for libraries, `vite build` for the frontend | Simple, deterministic, no bundler magic in the enclave |

---

## Test coverage and quality bars

GhostBroker ships with a comprehensive automated test suite. The
headline numbers are:

- **554 tests passing across 104 test files**, with `tsc --noEmit`
  clean on every workspace.
- 1 test file is skipped by default (8 tests) and gated behind
  `WS2_ANVIL_INTEGRATION=1` so it only runs when a local Anvil node
  is up. Set the env var to add 8 on-chain tests that deploy the
  relayer and assert real `Settled` event decoding.

Per-workspace breakdown:

| Workspace | Test files | Tests passing | Tests skipped |
|---|---|---|---|
| `negotiation-core` | 1 | 27 | 0 |
| `t3-enclave` | 12 | 79 | 0 |
| `backend` | 57 | 194 | 8 (chain-sepolia, gated) |
| `frontend` | 17 | 72 | 0 |
| `agent-client` | 9 | 56 | 0 |
| `agents` | 8 | 126 | 0 |
| **Total** | **104** | **554** | **8** |

The suite covers four broad categories:

1. **Privacy regression.** The redact-event allowlist is tested for
   every forbidden field. The frontend privacy test renders every
   dashboard surface and asserts no plaintext trading field appears.
   Playwright's `dashboard-privacy.spec.ts` does the same in a real
   browser. The contract test for `POST /api/agents/intents` confirms
   plaintext `asset`/`side`/`quantity`/`price` is rejected.
2. **Authority verification.** The Ghostbroker delegation verifier is
   tested for valid VC, stable `policyHash`, stale `authorityRef`,
   and expired credentials. The orchestrator's `loadAndVerify` path
   is tested through `negotiation-orchestrator` and
   `hosted-demo-settlement` suites.
3. **Settlement rails.** Both the noop rail and the Sepolia chain
   rail are tested end-to-end. The Anvil integration test deploys
   the relayer + 2 minimal ERC-20s, funds them, approves the
   relayer, dispatches a real trade, and asserts `Settled` event
   decoding and `Transfer` balance round-trip.
4. **Negotiation protocol.** The orchestrator's disclosure gate,
   escalation gate, and reveal/counter choreography are tested
   end-to-end through the `negotiation-orchestrator` suite.

The full agent developer experience - claim an API key, deploy an
agent, submit intents, watch settlements - is documented in
[`docs/agent-integration/`](docs/agent-integration/) and walked through
end-to-end in the
[`AgentDeploymentGuide`](frontend/src/components/AgentDeploymentGuide.tsx)
component of the dashboard itself.

---

## Local development setup

### Prerequisites

- Node.js 20.19 or newer
- npm 10+
- A Terminal 3 sandbox API key (`T3N_API_KEY`). The backend needs
  this to provision the tenant private maps and to publish the
  matching contract. See [T3 docs](https://docs.terminal3.io/).
- A Supabase project URL + service-role key (for the backend) and an
  anon key (for the frontend).
- (Optional) For the Sepolia settlement rail: a Sepolia RPC URL, a
  funded relayer private key, and a deployed `GhostBrokerSettlementRelayer`
  contract address.

### Bootstrap

```powershell
# 1. From the repo root, install all workspace deps
npm install

# 2. Copy the env templates
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
Copy-Item t3-enclave/.env.example t3-enclave/.env

# 3. Fill in the secrets (see "Environment variables" below)

# 4. Build the libraries
npm run build

# 5. Run typecheck + lint + tests
npm run typecheck
npm run lint
npm test

# 6. (Optional) Add the on-chain integration tests
$env:WS2_ANVIL_INTEGRATION = "1"
npm test
```

### Day-to-day commands

```powershell
# Run the backend (port 3001 by default)
npm run dev --workspace @ghostbroker/backend

# Run the dashboard (port 5173 by default)
npm run dev --workspace @ghostbroker/frontend

# Probe the live Terminal 3 sandbox
npm run sandbox:check --workspace @ghostbroker/t3-enclave

# Run the hosted buyer / seller / negotiator
npm run buyer --workspace @ghostbroker/backend
npm run seller --workspace @ghostbroker/backend
npm run hosted --workspace @ghostbroker/backend
```

### Recommended local test order

The backend's contract tests spin up the full Express app in-process
and exercise the entire privacy boundary. They run fastest when run
on their own:

```powershell
npm test --workspace @ghostbroker/backend
```

The frontend's React Testing Library tests cover component behavior
and accessibility:

```powershell
npm test --workspace @ghostbroker/frontend
```

The T3 enclave's verifier tests cover the W3C VC verifier in all
three modes:

```powershell
npm test --workspace @ghostbroker/t3-enclave
```

The `agent-client` tests cover the published SDK; the `agents`
tests cover the hosted negotiator:

```powershell
npm test --workspace @ghostbroker/agent-client
npm test --workspace @ghostbroker/agents
```

---

## Environment variables

The full `.env.example` files live in each workspace. The fields
that matter most:

### `backend/.env`

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Defaults to `3001` |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service-role key (kept server-side only) |
| `T3N_API_KEY` | yes | Terminal 3 sandbox API key |
| `T3_TENANT_DID` | yes | The institution's Terminal 3 DID |
| `T3_MODE` | no | `sandbox` (default), `structural`, or `live` |
| `VC_VERIFY_MODE` | no | Backward-compat alias for `T3_MODE` |
| `VC_VERIFY_STRICT` | no | No-op alias retained for backwards compatibility. The verifier always fails closed on any `@terminal3/verify_vc` exception outside `sandbox` mode; `sandbox` is the only mode in which the historical "verified on SDK error" behaviour is preserved. |
| `OPERATOR_CHALLENGE_TTL_SECONDS` | no | DID challenge-response TTL, defaults to `300` |
| `OPERATOR_SESSION_TTL_SECONDS` | no | Operator JWT TTL, defaults to `28800` (8h) |
| `AGENT_SESSION_TTL_SECONDS` | no | Agent JWT TTL, defaults to `28800` (8h) |
| `SETTLEMENT_ASSET_CODE` | yes | Asset code for the institution's settlement token |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL` | no | Enables the chain rail when set |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY` | no | Required if the RPC URL is set |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS` | no | Required if the RPC URL is set |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID` | no | Defaults to `11155111` (Sepolia) |
| `SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` | no | When set, switches the relayer signer to the T3 tenant TEE |
| `ETHERSCAN_API_KEY` | no | Enables Sepolia portfolio sync |
| `SEPOLIA_WBTC_CONTRACT_ADDRESS` | no | Required if Etherscan sync is enabled |
| `SEPOLIA_USDC_CONTRACT_ADDRESS` | no | Required if Etherscan sync is enabled |
| `WS2_ANVIL_INTEGRATION` | no | Set to `1` to run the Anvil integration tests |

### `frontend/.env`

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | yes | Backend REST URL (default `http://localhost:3001`) |
| `VITE_WS_BASE_URL` | yes | Backend WebSocket URL |
| `VITE_SUPABASE_URL` | yes | Supabase project URL (anon) |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon key |
| `VITE_OPERATOR_DID_CHALLENGE_URL` | yes | The `/api/auth/challenge` endpoint |
| `VITE_OPERATOR_DID_VERIFY_URL` | yes | The `/api/auth/verify` endpoint |

### `t3-enclave/.env`

| Variable | Required | Description |
|---|---|---|
| `T3N_API_KEY` | yes | Mirrored from the backend for sandbox probing |
| `T3_TENANT_DID` | yes | The institution's Terminal 3 DID |

### `agents/.env`

| Variable | Required | Description |
|---|---|---|
| `GHOSTBROKER_URL` | yes | Backend URL (default `http://localhost:3001`) |
| `GHOSTBROKER_API_KEY` | yes | The `gbk_...` key from the dashboard's API Keys panel |
| `AGENT_DID` | no | If set, the agent uses this DID instead of generating one |
| `GEMINI_API_KEY` | yes (one of) | Primary LLM provider |
| `OPENAI_API_KEY` | optional | Fallback #1 |
| `GROQ_API_KEY` | optional | Fallback #2 |
| `LLM_PROVIDER_CHAIN` | no | Comma-separated provider ids to override the chain order |
| `TICK_INTERVAL_MS` | no | Decision cadence, defaults to `15000` |
| `DRY_RUN` | no | Set to `1` to disable submission |

---

## Quick start: end to end

This is the fastest path from a clean checkout to a settled trade:

1. **Start the backend.** Fill in `backend/.env`, then
   `npm run dev --workspace @ghostbroker/backend`. The backend
   initializes the T3 enclave, provisions tenant private maps
   (`secrets`, `authority-claims`, `match-config`,
   `settlement-config`), publishes the matching contract, and
   exposes `/healthz` for liveness probes.

2. **Start the dashboard.** Fill in `frontend/.env`, then
   `npm run dev --workspace @ghostbroker/frontend`. Sign in with
   your Terminal 3 wallet. The Observatory Console shows the
   institution DID, the backend connection, the WebSocket, the
   Supabase status, and the T3 sandbox status.

3. **Provision an API key.** In the dashboard's Developer Keys
   panel, generate a `gbk_...` API key. The key is shown once and
   persisted hashed in Supabase. The hash is what the backend
   compares against on `POST /api/auth/api-key`.

4. **Deploy an agent.** Use the Agent Deployment Guide in the
   dashboard, or run `npm run hosted --workspace @ghostbroker/backend`
   after copying `backend/.env.example` to `backend/.env` and filling
   in the API key + at least one LLM provider.

5. **Watch it settle.** The hosted agent mints its DID, admits
   itself through `POST /api/agents/admit`, fetches its mandate,
   starts the negotiation loop, and submits moves through
   `POST /api/negotiations/:id/move`. The dashboard's
   `LiveAgentActivityStream` and `TeeNegotiationVisualizer` light
   up as the orchestrator evaluates each move. On a crossed price
   band, the orchestrator gates settlement on the disclosure
   handshake, then dispatches the settlement rail. The completed
   trade appears in the `CompletedTradesTable` within seconds.

---

## REST API tour

The backend exposes a typed REST API. The full contract is enforced
by Zod schemas on the wire side and zod-parsed test fixtures in the
contract tests.

### Public surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/api/health` | Detailed subsystem health (backend, websocket, supabase, T3 sandbox) |
| `POST` | `/api/auth/challenge` | Start an operator DID challenge-response |
| `POST` | `/api/auth/verify` | Complete the operator challenge, return operator JWT |
| `POST` | `/api/auth/api-key` | Exchange an agent's `gbk_...` API key for an 8-hour agent JWT |
| `POST` | `/api/agents/admit` | Admit an agent; persists the Ghostbroker delegation VC server-side |
| `PATCH` | `/api/agents/:agentId/configure` | Update label, instrument scope, direction scope, max notional, policy hash |
| `PATCH` | `/api/agents/:agentId/label` | Update label only |
| `POST` | `/api/agents/:agentId/revoke` | Revoke the agent; writes to `agent_authority_revocations` |
| `GET` | `/api/agents` | List admitted agents for the institution |
| `POST` | `/api/agents/intents` | Submit an encrypted intent envelope |
| `POST` | `/api/agents/intents/:handle/cancel` | Cancel a pending intent |
| `GET` | `/api/agents/intents` | List pending intents for the institution |
| `GET` | `/api/trades/completed` | List completed trades (encrypted fields) |
| `GET` | `/api/receipts/:id` | Fetch an audit receipt by id |
| `GET` | `/api/portfolios/:institutionId` | Read the institution's portfolio |
| `GET` | `/api/portfolios/:institutionId/agent` | Read a single agent's portfolio |
| `POST` | `/api/negotiations` | Open a negotiation session |
| `POST` | `/api/negotiations/:id/move` | Submit a move (propose, counter, reveal, request_disclosure, accept, hold, walkaway) |
| `POST` | `/api/negotiations/:id/disclose` | Submit a reciprocal disclosure claim |
| `POST` | `/api/negotiations/:id/approve` | Operator approval of an escalated cross |
| `POST` | `/api/negotiations/:id/decline` | Operator decline of an escalated cross |
| `POST` | `/api/negotiations/:id/settle` | Force-settle after operator approval |
| `GET` | `/api/negotiations/:id` | Read session state (current turn, round, escalation status) |
| `POST` | `/api/admin/trades/:tradeRef/reverse` | Reverse a settled trade (operator only) |
| `GET` | `/api/institutions` | List institutions the operator owns |
| `POST` | `/api/institutions` | Create a new institution |
| `PATCH` | `/api/institutions/:id` | Update institution metadata |

The error responses are stable across SDK versions: every non-2xx
returns a JSON body of shape `{ "code": "<string>", "message": "<string>", "status": <number> }`. The `code` is one of:

- `authorization_failed` (401/403) - re-authenticate and retry
- `validation_failed` (400) - request body did not parse; do not retry
- `not_found` (404) - resource does not exist
- `service_unavailable` (503) - sandbox not reachable; back off and retry
- `request_failed` (500) - unexpected upstream; back off and retry

See [`docs/agent-integration/ERROR_REFERENCE.md`](docs/agent-integration/ERROR_REFERENCE.md)
for the full per-endpoint error catalog.

---

## WebSocket telemetry tour

The backend runs a typed telemetry WebSocket at `/ws/telemetry`. The
frontend connects after operator authentication, and the backend
filters events to the operator's institution only.

### Event shape

Every event has the shape:

```typescript
{
  event_id: string;
  institution_id: string;
  agent_id?: string;
  status: string;            // sanitized state label
  phase: string;              // phase transition
  severity: "info" | "warn" | "error";
  timestamp: string;          // ISO 8601
  correlation_ref?: string;
  receipt_ref?: string;
  // ...additional allowlisted fields, no plaintext
}
```

The allowlist is enforced by `backend/src/websocket/redact-event.ts`,
which strips any field on the deny list and drops the event if it
would otherwise leak a forbidden value.

### Allowed phases

```
backend_connected
websocket_connected
supabase_connected
t3_sandbox_connected
agent_connected
agent_disconnected
agent_verifying
agent_verified
agent_rejected
authority_revoked
intent_received
intent_sealed
encrypted_evaluation
settlement_pending
settlement_finalized
receipt_available
authorization_failed
token_metering_failed
settlement_failed
service_unavailable
```

### Forbidden payload fields

```
asset
side
quantity
bid
ask
price
execution_price_plaintext
counterparty
queue_depth
queue_rank
match_score
raw_payload
plaintext
contract_args
secret
private_key
```

The frontend client is
[`frontend/src/services/telemetry-client.ts`](frontend/src/services/telemetry-client.ts).
It implements exponential-backoff reconnect (1s, 2s, 4s, ..., capped
at 30s) and exposes convenience handlers for `onSettled`,
`onError`, `onMessage`, and `onStatusChange`.

The SDK equivalent is in
[`agent-client/src/websocket-client.ts`](agent-client/src/websocket-client.ts)
and exposes the same handlers.

---

## Agent developer tour

The hosted agents are built on the same `@ghostbroker/agent-client`
SDK that external developers use. The SDK is the published TypeScript
package; nothing in the agent runtime uses internal APIs the SDK does
not expose.

```typescript
import { GhostBrokerClient } from "@ghostbroker/agent-client";

const client = new GhostBrokerClient({
  baseUrl: process.env.GHOSTBROKER_URL!,
});

// 1. Exchange the API key for an 8-hour session
const session = await client.authenticateWithApiKey(
  process.env.GHOSTBROKER_API_KEY!,
);

// 2. Admit the agent. The backend loads and verifies the persisted
//    delegation VC; the agent process never sends the VC.
const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
});

// 3. Submit encrypted intents
const intent = await client.submitIntent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  encryptedIntentEnvelope: enclaveSealedEnvelope,
  authorityRef: admission.authorityRef,
});

// 4. Listen for the settlement event
client.telemetry.onSettled((correlationRef) => {
  console.log("Settlement finalized:", correlationRef);
});
client.telemetry.connect();
```

The SDK surfaces every endpoint through typed methods and every
non-2xx as a `GhostBrokerApiError` with a stable `code`. See
[`agent-client/README.md`](agent-client/README.md) for the full
method catalog and
[`docs/agent-integration/`](docs/agent-integration/) for the
end-to-end integration walkthrough.

The seven-doc integration series covers:

- [`OVERVIEW.md`](docs/agent-integration/OVERVIEW.md) - the agent
  developer journey at a glance
- [`AUTHENTICATION.md`](docs/agent-integration/AUTHENTICATION.md) -
  API key vs. session token vs. challenge-response
- [`DEPLOY_YOUR_AGENT.md`](docs/agent-integration/DEPLOY_YOUR_AGENT.md) -
  the deployment checklist
- [`INTENT_SUBMISSION.md`](docs/agent-integration/INTENT_SUBMISSION.md) -
  sealing envelopes and submitting intents
- [`SETTLEMENT_AND_RECEIPTS.md`](docs/agent-integration/SETTLEMENT_AND_RECEIPTS.md) -
  reading completed trades and audit receipts
- [`WEBSOCKET_TELEMETRY.md`](docs/agent-integration/WEBSOCKET_TELEMETRY.md) -
  telemetry events, phases, reconnect strategy
- [`API_REFERENCE.md`](docs/agent-integration/API_REFERENCE.md) -
  the full REST + WebSocket reference

---

## The negotiation loop

The hosted negotiator runs a per-tick loop that drives a
verifiable-authority negotiation protocol, not a free-form
LLM-vs-LLM chat:

1. The agent fetches its mandate at admit. The mandate is an
   author-authored policy surface (objective, execution style,
   valuation policy, concession policy, disclosure policy,
   approval policy, counterparty requirements, size policy,
   time window) plus derived numeric rails (anchor value,
   walkaway min/max, concession budget in bps, notional ceiling).
2. On each tick, the agent sends a structured prompt through the
   LLM fallback chain. The system message forces JSON output
   (`{action, price, quantity, reasoning, confidence}`).
3. The decision is parsed and re-validated with zod, then
   **clamped** to the mandate's bands: price inside the price band,
   quantity inside the size policy, walkaway within the
   concession budget.
4. On `propose` / `counter` / `reveal` / `accept`, the agent
   submits a move. The orchestrator evaluates it, advances the
   turn, and emits telemetry.
5. On a crossed price band, the orchestrator gates settlement on
   the disclosure handshake. The default requires only the
   `accredited_institution` claim from each side; reciprocal
   `settlement_capacity` is supported as an optional tighter gate.
6. If the buyer's price exits the preferred envelope, the
   orchestrator marks the session `escalation_status: "pending"`
   and refuses to settle until the operator approves or declines
   via `POST /api/negotiations/:id/approve` or
   `POST /api/negotiations/:id/decline`.
7. On settlement, the orchestrator calls the settlement rail
   (`wallet:default` for the demo, `chain:sepolia:erc20` when
   configured), persists the `completed_trades` row with
   ciphertext asset / quantity / price fields, generates the
   audit receipt, and emits `settlement_finalized` + the
   `receipt_available` phase.

---

## The LLM provider chain

Every LLM call in the agent loop runs through a fallback chain:

```
Gemini (gemini-3.1-flash-lite) -> OpenAI (gpt-5-nano) -> Groq (qwen/qwen3-32b)
```

A failure is treated as **transient** (and the chain falls back to
the next provider) when it is:

- A 5xx server error from the provider
- A 408 / 429 rate-limit error
- A network error (timeout, DNS, TLS)
- An empty completion
- A malformed JSON body

A failure is treated as **fatal** (no fallback) when it is a 401 / 403
auth error or a 400 / 404 bad-request error - the same prompt is
unlikely to succeed on a different provider, so we surface the error
to the agent loop immediately. When every provider has failed with a
transient error, the chain throws an `AggregateLlmError` whose
`.errors` array carries each provider's `LlmProviderError`.

Override the order with `LLM_PROVIDER_CHAIN=groq,openai` to prefer
Groq. The chain is implemented in
[`agents/src/llm/fallback-chain.ts`](agents/src/llm/fallback-chain.ts).

---

## Privacy enforcement layers

The privacy boundary is enforced at four independent layers so a
single regression cannot silently leak a forbidden field.

### Layer 1: Zod schema at the intent edge

`backend/src/validation/encrypted-intent.schema.ts` is the canonical
parser for `POST /api/agents/intents`. Any plaintext `asset`,
`side`, `quantity`, or `price` field triggers
`Plaintext trading field is not accepted at $<field>` and the
request returns `400 validation_failed` before it ever reaches the
orchestrator.

The contract test
[`backend/src/tests/contracts/agents-intents-privacy.contract.test.ts`](backend/src/tests/contracts/agents-intents-privacy.contract.test.ts)
exercises every forbidden field individually and confirms the error
message includes the offending path.

### Layer 2: WebSocket allowlist

`backend/src/websocket/redact-event.ts` is the gate every telemetry
event crosses before it leaves the backend. The implementation is an
allowlist: only `event_id`, `institution_id`, `agent_id`, `status`,
`phase`, `severity`, `timestamp`, `correlation_ref`, `receipt_ref`,
plus a small set of derived fields (count, instance, etc.) survive
the strip. Everything else is dropped.

If an event payload would leak a forbidden field, the redaction
guard logs a `[TelemetryClient] Security Violations Detected` warning
and drops the entire event. The unit test
[`frontend/src/test/telemetry-client.test.ts`](frontend/src/test/telemetry-client.test.ts)
asserts this behavior on the client side.

### Layer 3: Database schema

Active trade columns are stored as ciphertext:
`asset_code_ciphertext`, `quantity_ciphertext`,
`execution_price_ciphertext`. The corresponding plaintext never
crosses the Supabase boundary. RLS policies in
[`database/policies/row-level-security.sql`](database/policies/row-level-security.sql)
restrict reads to the participating institution, so a leaked
service-role key still does not reveal another institution's data.

### Layer 4: Frontend tests

[`frontend/src/test/privacy-redaction.test.tsx`](frontend/src/test/privacy-redaction.test.tsx)
renders every dashboard surface (dashboard, agents panel,
completed history, encrypted receipt drawer, processing status,
mandate editor, agent deployment guide) and asserts that no rendered
string contains a forbidden field name. Playwright's
[`tests/dashboard-privacy.spec.ts`](tests/dashboard-privacy.spec.ts)
does the same at the browser level against the running dashboard.

---

## Settlement rails

GhostBroker ships three settlement profiles. Every institution picks
exactly one via `institutions.settlement_profile_ref`. The rail is
the only thing that physically moves assets; everything else is
bookkeeping.

### `wallet:default` (noop)

Nothing moves. The system writes a `completed_trades` row with
`rail_id = "wallet:default"` and `rail_trade_ref = "noop:<sha256>"`.
No external transport. Suitable for the demo "Spin up demo agents"
button and for any test or non-production environment where
real-asset movement is not desired.

### `chain:sepolia:erc20` (Sepolia)

Real ERC-20 `transferFrom` calls on Sepolia, routed through the
on-chain [`GhostBrokerSettlementRelayer`](contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol)
contract. The relayer holds the pre-approved ERC-20 allowances from
each institution's deposit address. The relayer's `settle(...)` is a
single transaction that:

1. Pulls the asset (e.g. WBTC) from the buyer's deposit address to
   the seller's deposit address.
2. Pulls the payment (e.g. USDC) from the seller's deposit address
   to the buyer's deposit address.
3. Emits a `Settled` event whose `outcomeRef` matches the TEE's
   opaque match outcome.

The on-chain calldata is the relayer's `settle(bytes32, bytes32,
address, address, address, address, uint256, uint256)` ABI. A
public chain observer sees the institution's deposit addresses and
the asset/payment amounts but **not** the TEE-decrypted
`quantity * price` semantics - the relayer is the canonical source
of those, not the chain.

The Anvil integration test (gated by `WS2_ANVIL_INTEGRATION=1`)
deploys the relayer + 2 minimal ERC-20s, funds them, approves the
relayer, dispatches a real trade, and asserts real `Settled` event
decoding and `Transfer` balance round-trip.

### `custody:<partner>`

Reserved for future custody partners. Not implemented in v1;
passing the profile name throws `RailDispatchError`.

The relayer signer is a deliberate seam. The v1 demo path is a
`ViemWalletRelayerSigner` that signs the broadcast with the
`SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY` env var. The
production swap is a `TeeAttestedRelayerSigner` whose
`tenantPrivateKey` is the T3 tenant identity loaded via
`t3-enclave`'s `loadOrCreateTenantIdentity(...)`. When
`SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` is set (a T3
secret-ref), the wiring resolves it through the enclave's secret
store and builds the TEE-attested signer. The production tenant
key is held inside the T3 tenant TEE; the v1 demo's tenant key is
the file-backed keypair the matching-policy contract also uses.
The on-chain `from` is the tenant identity's address either way;
in production the key's extraction is attestation-anchored.

The reverser endpoint
(`POST /api/admin/trades/:tradeRef/reverse`) is the only path that
can flip a settled row's `settlement_status`. The reconciler
(system task) is read-only and surfaces drift via a high-severity
`rail_drift_detected` telemetry event.

The operator-facing runbook is at
[`docs/settlement-rails.md`](docs/settlement-rails.md).

---

## Database schema

The canonical schema lives at [`database/schema.sql`](database/schema.sql)
(context only - not meant to be run). Migrations are numbered SQL
files under [`database/migrations/`](database/migrations/) with RLS
policies under [`database/policies/`](database/policies/) and dev
seed data under [`database/seed/`](database/seed/).

The schema enforces the privacy boundary at the column level:

| Table | Sensitive columns | Storage |
|---|---|---|
| `completed_trades` | `asset_code_ciphertext`, `quantity_ciphertext`, `execution_price_ciphertext` | ciphertext |
| `intent_locks` | `asset_code`, `amount`, `correlation_ref` | identifier-only, encrypted handles |
| `audit_receipts` | `receipt_ciphertext`, `receipt_hash`, `key_version`, `t3_attestation_ref` | ciphertext + non-sensitive references |
| `negotiation_mandates` | `objective`, `execution_style`, `valuation_policy`, `concession_policy`, `disclosure_policy`, `approval_policy`, `counterparty_requirements`, `size_policy`, `time_window` | structured JSON policy surface |
| `negotiation_rounds` | `proposal_ciphertext`, `disclosed_claim_refs`, `opaque_signal` | ciphertext + non-sensitive references |
| `negotiation_disclosures` | `claim_assertion_ciphertext`, `t3_attestation_ref` | ciphertext + non-sensitive references |

RLS policies restrict all reads to the participating institution;
a leaked service-role key still does not reveal another institution's
data. The audit receipt drawer relies on the institution's own
receipt key (held inside the T3 tenant private map) for decryption.

The migration history includes:

- 001 - `institutions` (initial institution metadata)
- 002 - `completed_trades` (post-settlement ciphertext records)
- 003 - `audit_receipts` (encrypted receipt payloads + references)
- ...through the current migration set, which includes `agents`,
  `intent_locks`, `portfolios`, `portfolio_history`, `api_keys`,
  `agent_authority_revocations`, and the `negotiation_*` family
  used by the hosted negotiator.

---

## Design system

The design is named **"The Attested Enclave"** and rejects typical
neon-slop consumer crypto widgets, SaaS-blue layouts, and
multi-colored grid cards. The canonical reference is
[`DESIGN.md`](DESIGN.md) and [`PRODUCT.md`](PRODUCT.md).

### Visual drivers

- Dark, monochromatic foundations with a single emerald accent
  (`#5ed29c`) used strictly for successful cryptographic
  attestation or key CTA states. The **Rarity Rule** caps
  emerald at 10% of any visible screen surface.
- Double-mask composited glassmorphic border elements providing
  depth without traditional drop shadows (the **Flat-By-Default
  Rule**).
- Clear typographic separation: Cinzel for display, Plus Jakarta
  Sans for body, Share Tech Mono for cryptographic data, and
  Instrument Serif (italic) for occasional highlights.

### Component conventions

- Buttons: pill-shaped (9999px radius). Primary is emerald on
  black-tint. Hover translates -2px with a subtle outer glow.
- Cards: 24px outer radius, 12px nested radius, glassmorphic
  background (`rgba(255, 255, 255, 0.01)`) with a 12px backdrop
  blur and a 1.2px double-mask gradient border.
- Inputs: 8px radius, focus state turns the border to emerald
  with a subtle glow.
- Telemetry: monospace Share Tech Mono for all cryptographic
  data (DIDs, hashes, attestation refs, ciphertext previews).

### Operator-only disclaimers

The dashboard surfaces a permanent "Zero Human Access" TEE secure
enclave disclaimer in compliance boundaries. The encrypted receipt
drawer renders the receipt hash and T3 attestation reference in
monospace to reinforce the cryptographic authority. The completed
trade table never shows asset codes or quantities - only the
trade ref, settlement status, timestamp, and a link to the
receipt.

---

## Operational playbooks

### Backend restart safety

The intent-lock repository is the source of truth for in-flight
intents. On backend restart, the orchestrator reconciles active
locks against the matching contract's pending queue and either
re-queues the intent (if the contract still has it) or marks it
expired. The behavior is covered by
[`backend/src/tests/integration/intent-lock-restart-safety.test.ts`](backend/src/tests/integration/intent-lock-restart-safety.test.ts).

### Settlement rail drift

The settlement reconciler runs as a system task and compares the
backend's `completed_trades` rows against the chain rail's
on-chain receipts. Any drift surfaces as a high-severity
`rail_drift_detected` telemetry event and is logged to the audit
table. The reconciler is read-only - it never moves assets. The
operator-facing reverser endpoint is the only path that can flip
a settled row's status.

### Revocation propagation

Revoking an agent writes a row to `agent_authority_revocations`.
The verifier reads the table before every privileged action and
includes the revoked set in the `revokedAuthorityRefs` parameter.
A revoked `authorityRef` is rejected on the next privileged call
within seconds of revocation. The integration test
[`backend/src/tests/integration/agent-admission.test.ts`](backend/src/tests/integration/agent-admission.test.ts)
exercises revocation rejection end-to-end.

### Token exhaustion

T3N tokens meter execution and storage. The backend checks the
tenant token balance before metered operations and applies bounded
retries for non-committed write conflicts. Token exhaustion is
treated as a redacted operational failure (`token_metering_failed`)
and is not retried indefinitely. The integration test
[`backend/src/tests/integration/settlement-token-exhaustion.test.ts`](backend/src/tests/integration/settlement-token-exhaustion.test.ts)
covers the failure path.

### Escalation flow

When a buyer's price exits the preferred envelope, the
orchestrator marks the session `escalation_status: "pending"`
and the orchestrator refuses to settle priced crosses until the
operator approves or declines via `POST /api/negotiations/:id/approve`
or `POST /api/negotiations/:id/decline`. The negotiation tests
cover all four sub-cases: auto-settle on a clean cross,
blocks-settlement on envelope exit, forces-the-gate-open on a
wider counter, operator-approval re-evaluates, operator-decline
expires the session.

---

## Deployment topology

### Frontend (Vercel)

The Vite build outputs to `frontend/dist`. Vercel picks up the
workspace via the root `package.json` workspaces config. The
build command is `npm run build --workspace @ghostbroker/frontend`,
the output directory is `frontend/dist`, and the env template is
[`docs/deployment/vercel-frontend.md`](docs/deployment/vercel-frontend.md).
The dashboard is a static SPA; there is no server runtime.

### Backend (Heroku)

The Procfile at [`backend/Procfile`](backend/Procfile) declares
the web process and any one-off tasks (the settlement reconciler
runs as a worker). The build is `npm run build --workspace
@ghostbroker/backend` followed by `tsc` against the workspace
manifest. The release phase runs `npm run typecheck --workspace
@ghostbroker/backend`.

### Database (Supabase)

Migrations are applied in numeric order from `database/migrations/`.
RLS policies in `database/policies/` are applied once and are
idempotent. Seed data in `database/seed/` is for development only;
never apply it to production.

### Confidential execution (Terminal 3 TEE)

The tenant identity is loaded from `t3-enclave`'s file-backed
identity store, with the production swap being the T3 tenant TEE.
The matching contract and the receipt key live inside the tenant
TEE and are never written to disk in plaintext.

### Optional: Sepolia settlement rail

When the rail is enabled (the three env vars are set), the
relayer signer is wired with either the v1 viem path (env-var
key) or the production TEE-attested path (T3 secret-ref). The
on-chain `from` is the tenant identity's address either way; in
production the key's extraction is attestation-anchored.

---

## Security

### Treat secrets as secrets

- **API keys** (`gbk_...`) are persistent and authorize every
  action the agent can take until revoked. Store them in a
  secrets manager (AWS Secrets Manager, HashiCorp Vault,
  environment-injected secret). Never commit them. Never log them.
- **Session tokens** are short-lived (8 hours) and lower-privilege
  than the API key. If a session token leaks, rotate the API key
  to invalidate all active sessions.
- **Relayer private keys** are held by the v1 demo path in env
  vars; the production swap is the T3 tenant TEE.
- **Receipt decryption keys** are held inside the T3 tenant
  private map. The matching contract reads them inside the
  enclave; they never cross the boundary in plaintext.
- **Webhook secrets / Supabase service-role keys** are server-side
  only. The frontend gets the anon key, which is bound by RLS.

### Defense in depth

- TypeScript strict mode everywhere; no `any` in production code.
- Zod schemas at every wire boundary.
- Allowlist-based telemetry redaction at the WebSocket gate.
- Row-level security on every Supabase table.
- Rarity Rule on the emerald accent in the design system -
  treats any green UI element as a hard "this is attested"
  signal.

### Reporting

Please file security issues privately. Do not file public GitHub
issues for vulnerabilities.

---

## Documentation gaps filed against T3

Per the bounty criteria, we filed
[`docs/terminal3-adk-onboarding-doc-gaps.md`](docs/terminal3-adk-onboarding-doc-gaps.md)
capturing onboarding bugs, contradictions, and documentation gaps
we hit. The largest classes:

- **Programmatic AI agent delegation is undocumented.** The T3N
  Dashboard delegation flow is documented; the SDK/API surface
  for the same operation is not. The post-Phase 1 architecture
  works around this by making the backend own the persisted VC.
- **`agent-auth` Host API is marked coming soon.** We built
  against the assumption it is *not* available to app contracts
  and used the documented Dashboard delegation path.
- **Typed error handling is missing.** The ADK returns
  human-readable detail strings; we substring-match in an
  adapter to map to internal categories. Filed for a future
  typed-SDK release.

The full addendum also covers program-matic capability matrix
availability, map ACL defaults, token metering failure semantics,
attestation verification workflow, and contract lifecycle
playbooks.

---

## Reference workspace

[`ghostbroker-delegation-reference/`](ghostbroker-delegation-reference/)
is a worked example of a Terminal 3 delegated-agent pattern
implemented as a separate npm package. It ships a procurement
agent that demonstrates the same delegation, policy engine, and
audit log patterns GhostBroker uses, scoped to a single
enterprise use case. It is not on the production path of the
dark pool; it is reference material for integrators who want to
build their own delegated-agent product on Terminal 3.

It has its own test suite (2 files, 8 tests) and is published
under its own `package.json` (`t3-procurement-agent`). The
relevant Terminal 3 docs pages are linked from its README.

---

## Contributing

We welcome bug reports, feature requests, and pull requests on the
GitHub repo. The repo follows a few conventions worth knowing:

- The repo ships as npm workspaces. Run `npm install` at the root
  to set up everything.
- Every workspace has `typecheck`, `lint`, `build`, and `test`
  scripts. The root scripts (`npm run typecheck`, `npm test`,
  etc.) run them in the right order.
- The privacy boundary is enforced by tests. Any change to a
  privacy-sensitive surface (intent schema, telemetry event
  shape, database column, dashboard text) should add or update a
  test that asserts the boundary is still intact.
- The terminal-3 boundary is enforced at the import-graph level.
  Code in `frontend/`, `agents/`, or `agent-client/` should not
  import from `t3-enclave/` or the T3 ADK directly.
- We do not accept PRs that add new `any`, remove the
  redact-event allowlist, or store plaintext active-order
  fields in Supabase.

Run the full suite before submitting a PR:

```powershell
npm run typecheck
npm run lint
npm test
```

---

## License

MIT - see the LICENSE file in each package. The Solidity relayer
in [`contracts/relayer/`](contracts/relayer/) is also MIT.

The Terminal 3 ADK and T3N SDKs are governed by Terminal 3's own
licensing terms; see [https://docs.terminal3.io/](https://docs.terminal3.io/)
for the current terms.

---

This is the production code, the tests, the deployment topology,
the runbooks, and the SDK. Everything in this repository is real
code that runs locally and is wired to a live Terminal 3 sandbox.
The bounty submission narrative lives in
[`SUBMISSION.md`](SUBMISSION.md).