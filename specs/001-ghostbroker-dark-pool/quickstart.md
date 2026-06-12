# Quickstart: GhostBroker Implementation Plan

## Prerequisites

- Node.js 20 LTS
- Supabase project and database URL
- Heroku app for backend deployment
- Vercel project for frontend deployment
- Terminal 3 developer credentials, tenant DID access, T3N sandbox token balance, and ADK-compatible wallet or identity material

## Environment Variables

### Frontend

```text
VITE_API_BASE_URL=
VITE_WS_TELEMETRY_URL=
```

### Backend

```text
PORT=
DATABASE_URL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
T3_NETWORK_URL=
T3_TENANT_DID=
T3_WALLET_PRIVATE_KEY_REF=
T3_MATCH_CONTRACT_ID=
RECEIPT_KEY_VERSION=
```

### T3 Enclave

```text
T3_NETWORK_URL=
T3_SANDBOX_TOKEN_ACCOUNT=
T3_ADK_ENV=
T3_AUTH_SDK_ENV=
T3_PRIVATE_MAP_PREFIX=
```

## Local Setup

```powershell
npm install
npm run build --workspaces
npm run test --workspaces
```

## Database

```powershell
supabase db push
```

Expected migrations:

- `database/migrations/001_create_institutions.sql`
- `database/migrations/002_create_completed_trades.sql`
- `database/migrations/003_create_audit_receipts.sql`

## Backend

```powershell
Set-Location backend
npm run dev
npm run test
```

Contract checks:

- REST responses must match `contracts/openapi.yaml`.
- WebSocket events must match `contracts/websocket-events.md`.
- Redaction tests must fail if active order fields are emitted.

## Frontend

```powershell
Set-Location frontend
npm run dev
npm run test
```

Visual verification:

- Dashboard shows secure connection indicators.
- Dashboard shows completed trade history.
- Dashboard opens encrypted receipts.
- Dashboard does not show active order queue, active order counts, asset quantities, bid prices, ask prices, queue rank, or counterparty interest.

## T3 Enclave

```powershell
Set-Location t3-enclave
npm run test
npm run sandbox:check
```

Validation:

- Tenant DID can be resolved.
- Agent DID can be admitted or rejected.
- Private maps are created with explicit readers and writers.
- T3 token balance is checked before contract registration and execution.
- Matching returns only opaque handles and encrypted outcomes.

## Deployment

1. Deploy `frontend/` to Vercel with `VITE_API_BASE_URL` and `VITE_WS_TELEMETRY_URL`.
2. Deploy `backend/` to Heroku with Supabase and T3 environment variables.
3. Run Supabase migrations before enabling production traffic.
4. Validate WebSocket telemetry in production with a synthetic institution and test agent.

## Privacy Acceptance Checks

Before marking the milestone complete:

- Search REST fixtures, WebSocket fixtures, frontend snapshots, and logs for disallowed fields.
- Run Playwright privacy workflow for a non-participating institution.
- Confirm completed trade history excludes unrelated institution trades.
- Confirm receipt reads are scoped to authorized trade participants.
