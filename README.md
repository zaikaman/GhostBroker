# GhostBroker

GhostBroker is an institutional dark pool platform composed of a Vite React dashboard, an Express REST/WebSocket API, Supabase PostgreSQL migrations, and a dedicated Terminal 3 enclave package for confidential agent execution.

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
