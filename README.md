# GhostBroker

GhostBroker is an institutional dark pool platform composed of a Vite React dashboard, an Express REST/WebSocket API, Supabase PostgreSQL migrations, and a dedicated Terminal 3 enclave package for confidential agent execution.

## Headline: Terminal 3 Agent Auth SDK integration

GhostBroker integrates the **Terminal 3 Agent Auth SDK** for per-action authority verification. Every agent admission, every intent submission, and every settlement re-verifies a Terminal 3 delegation credential against institution policy. The integration lives in [`t3-enclave/src/auth/delegation-credential.ts`](t3-enclave/src/auth/delegation-credential.ts), which verifies signed delegation VCs end-to-end:

- **Cryptography**: `secp256k1` (EIP-191) user signature + `secp256k1` agent signature over a typed invocation preimage.
- **Authority reference**: every verification produces a `t3-delegation:<vc-id>` reference that the agent must echo back on every privileged action.
- **Function scoping**: the credential lists which actions the agent is authorized for (`agent.admit`, `intent.submit`, `settlement.execute`). Requests for unlisted actions are rejected as `over_scoped`.
- **Time windowing**: `not_before_secs` / `not_after_secs` are checked against the verifier's clock; expired or not-yet-valid credentials are rejected.
- **Revocation**: the verifier accepts a `revokedAuthorityRefs` set; revoked references are rejected before signature verification even runs.
- **Canonicalisation**: the credential body is JCS-canonicalised and compared byte-for-byte against the supplied canonical form, so a tampered credential cannot pass.

The verifier is the **fast path** when the proof is locally valid; if local verification fails, the verifier falls through to a live `POST /agent-delegations/verify` call on the Terminal 3 network (`agent-auth-client.ts`). This is the same facade used by every backend service — `AgentService.admitAgent`, `HiddenIntentService.submitIntent`, `HiddenIntentService.cancelIntent`, and `SettlementCommandBuilder.build` all call the **same** `T3AgentAuthorizationFacade` singleton, each with the right `requestedAction` for the action. See [`backend/src/auth/agent-authz.ts`](backend/src/auth/agent-authz.ts) and [`backend/src/app.ts`](backend/src/app.ts) (composition root) for the wiring.

Auth is layered: agents hold a persistent `gbk_…` API key to establish a session with the backend (exchanged at `POST /api/auth/api-key` for an 8-hour JWT — see [`agent-client/`](agent-client/) and [`docs/agent-integration/AUTHENTICATION.md`](docs/agent-integration/AUTHENTICATION.md) for the external agent developer experience); on every privileged action they then present a signed Terminal 3 delegation VC. The persistent key is the *session* credential, the signed VC is the *authority* credential. This is the separation the Terminal 3 docs use for the ["seed API key"](https://docs.terminal3.io/developers/adk/tips/seed-api-key) pattern, applied to the agent side of the boundary.

## Workspace Layout

- `frontend/`: operator dashboard for secure connectivity, completed history, and encrypted receipt workflows.
- `backend/`: Heroku-targeted API server with REST endpoints, WebSocket telemetry, Supabase access, and privacy redaction.
- `t3-enclave/`: Terminal 3 adapter boundary for identity, authority, hidden intent handling, matching, and settlement execution.
- `database/`: Supabase migrations, row-level security policies, and development seed data.
- `tests/`: Playwright dashboard and privacy checks.

## Local Commands

```powershell
npm install
npm run build --workspaces
npm run typecheck --workspaces
npm run lint --workspaces
npm run test --workspaces
npm run test:e2e --workspace @ghostbroker/frontend
```

Run package-specific development servers with:

```powershell
npm run dev --workspace @ghostbroker/frontend
npm run dev --workspace @ghostbroker/backend
npm run sandbox:check --workspace @ghostbroker/t3-enclave
```

## Environment Templates

Copy the relevant `.env.example` file for local development:

- `frontend/.env.example`
- `backend/.env.example`
- `t3-enclave/.env.example`

Never commit filled `.env` files, service-role keys, wallet material, private keys, or plaintext receipt material.

## Privacy Boundary

GhostBroker must not expose active hidden order details outside the Terminal 3 enclave boundary. Do not log, persist, render, or emit active order assets, sides, quantities, prices, queue depth, queue rank, match score, plaintext payloads, contract arguments, or counterparty interest through REST responses, WebSocket events, database rows, frontend screenshots, Playwright traces, or test fixtures.

Supabase stores institution metadata, completed trade records, encrypted receipt payloads, and non-sensitive operational references only. Active hidden intent state is represented outside the database by opaque Terminal 3 handles and sanitized telemetry.
