# GhostBroker
# GhostBroker

GhostBroker is an institutional dark pool platform composed of a Vite React dashboard, an Express REST/WebSocket API, Supabase PostgreSQL migrations, and a dedicated Terminal 3 enclave package for confidential agent execution.
## Headline: Terminal 3 Agent Auth SDK integration

GhostBroker integrates the **Terminal 3 Agent Auth SDK** for per-action authority verification. Every agent admission, every intent submission, and every settlement re-verifies a boundbuyer-style W3C Verifiable Credential — the only credential format the live T3N onboarding surface mints — against institution policy. The integration lives in [`t3-enclave/src/auth/boundbuyer-delegation.ts`](t3-enclave/src/auth/boundbuyer-delegation.ts), which runs in three modes (`sandbox` / `structural` / `live`) controlled by the server-side `VC_VERIFY_MODE` env var:

- **Shape + time window + DID binding**: every VC must have an `id`, `issuer`, `credentialSubject.agentDid`, `issuanceDate`/`expirationDate`, and a `proof` object. The verifier checks all of these.
- **Agent-binding**: the credential's `credentialSubject.agentDid` must match the agent DID on the request.
- **Revocation**: the verifier accepts a `revokedAuthorityRefs` set; revoked references are rejected before any further check.
- **Cryptographic verification** (live mode only): the verifier calls `@terminal3/verify_vc` at runtime if it's installed. Otherwise it falls back to `structural` checks (unless `VC_VERIFY_STRICT=true`).
- **Per-action re-verification**: every privileged action (`admit`, `submitIntent`, `cancelIntent`, `settlement.execute`) re-runs the verifier with the VC the agent was admitted with. The agent echoes the `authorityRef` (e.g. `boundbuyer-delegation:<vc-id>`) on every call, and the backend confirms the credential is still the same one on file. See [`backend/src/auth/agent-authz.ts`](backend/src/auth/agent-authz.ts) and the composition root in [`backend/src/app.ts`](backend/src/app.ts) for the wiring.

Auth is layered: agents hold a persistent `gbk_…` API key to establish a session with the backend (exchanged at `POST /api/auth/api-key` for an 8-hour JWT — see [`agent-client/`](agent-client/) and [`docs/agent-integration/AUTHENTICATION.md`](docs/agent-integration/AUTHENTICATION.md) for the external agent developer experience); on every privileged action they then re-verify their boundbuyer W3C VC. The persistent key is the *session* credential, the boundbuyer VC is the *authority* credential. This is the separation the Terminal 3 docs use for the ["seed API key"](https://docs.terminal3.io/developers/adk/tips/seed-api-key) pattern, applied to the agent side of the boundary.

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
