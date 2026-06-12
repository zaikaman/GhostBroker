# Implementation Plan: GhostBroker Institutional Dark Pool

**Branch**: `main` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/001-ghostbroker-dark-pool/spec.md`

## Summary

GhostBroker will be implemented as a TypeScript multi-project web platform for institutional dark pool trading. The frontend is a polished React + Vite dashboard deployed to Vercel. The backend is a Node.js + Express REST API with WebSocket telemetry deployed to Heroku. Supabase PostgreSQL stores institution metadata, completed trade history, audit receipts, and non-sensitive indexes. The dedicated `t3-enclave/` module owns the Terminal 3 ADK integration, agent identity registration, opaque hidden intent submission, encrypted matching, and settlement orchestration so active order parameters never leak into dashboard, logs, REST responses, or WebSocket messages.

## Technical Context

**Language/Version**: TypeScript on Node.js 20 LTS for frontend, backend, and T3 integration  
**Primary Dependencies**: React, Vite, Express, ws or Socket.IO, Supabase client, PostgreSQL migrations, Terminal 3 ADK, Terminal 3 Agent Auth SDK adapter, Vitest, React Testing Library, Playwright  
**Storage**: Supabase PostgreSQL for institutions, completed trade history, encrypted receipt metadata, audit references, and non-sensitive operational state  
**Testing**: Vitest for unit/integration tests, React Testing Library for dashboard behavior and accessibility, Supertest for REST contracts, WebSocket integration tests, Playwright for dashboard privacy checks  
**Target Platform**: Vercel frontend, Heroku backend, Supabase managed PostgreSQL, Terminal 3 T3N sandbox for tenant identity, token-metered TEE execution, and confidential contract execution  
**Project Type**: Web application with separate frontend, backend, database migrations, and confidential agent module  
**Performance Goals**: Dashboard status visible within 5 seconds; compatible eligible matches settled within 60 seconds for 95% of cases; frontend maintains 60fps transitions; initial dashboard load under 2 seconds on target broadband  
**Constraints**: No active order assets, quantities, bid/ask prices, order counts, queue positions, or counterparty identities may be emitted to browser, logs, Supabase tables, REST payloads, or WebSocket telemetry; TypeScript strict mode; no `any`; no plaintext credentials or private keys  
**Scale/Scope**: Initial institutional MVP supporting multiple institutions, multiple agents per institution, completed trade history, encrypted receipts, and a hidden intent queue managed only through opaque handles

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Code Quality & Maintainability**: PASS. All application code is planned in TypeScript with strict module boundaries and a dedicated `t3-enclave/` integration boundary.
- **Testing Discipline**: PASS. Plan requires unit, integration, contract, WebSocket, and Playwright privacy tests before implementation completion.
- **User Experience & Design Consistency**: PASS. Frontend is scoped as a scannable dashboard using centralized CSS tokens and no ad-hoc inline styling.
- **Performance & Responsiveness**: PASS. Plan keeps dashboard telemetry low-volume and separates confidential matching from UI rendering.
- **Zero-Knowledge & Security Compliance**: PASS. Active intent parameters remain opaque outside the Terminal 3 enclave boundary, and only completed trade history plus encrypted receipts are persisted for UI access.

Post-design check: PASS. Research, data model, contracts, and quickstart preserve the same privacy boundary and testing obligations.

## Project Structure

### Documentation (this feature)

```text
specs/001-ghostbroker-dark-pool/
|-- plan.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- contracts/
|   |-- openapi.yaml
|   `-- websocket-events.md
|-- checklists/
|   `-- requirements.md
`-- tasks.md                 # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
frontend/
|-- package.json
|-- vite.config.ts
|-- index.html
|-- src/
|   |-- app/
|   |   |-- App.tsx
|   |   `-- routes.tsx
|   |-- components/
|   |   |-- AgentConnectionGrid.tsx
|   |   |-- CompletedTradesTable.tsx
|   |   |-- EncryptedReceiptDrawer.tsx
|   |   |-- ProcessingStatusRail.tsx
|   |   `-- SecureMetric.tsx
|   |-- hooks/
|   |   |-- useConnectionTelemetry.ts
|   |   `-- useTradeHistory.ts
|   |-- services/
|   |   |-- api-client.ts
|   |   `-- telemetry-client.ts
|   |-- styles/
|   |   |-- theme.css
|   |   `-- dashboard.css
|   `-- test/
|       |-- privacy-redaction.test.tsx
|       `-- dashboard-accessibility.test.tsx
`-- tests/
    `-- dashboard.spec.ts

backend/
|-- package.json
|-- src/
|   |-- server.ts
|   |-- app.ts
|   |-- config/
|   |   `-- env.ts
|   |-- api/
|   |   |-- institutions.routes.ts
|   |   |-- agents.routes.ts
|   |   |-- trades.routes.ts
|   |   `-- receipts.routes.ts
|   |-- auth/
|   |   |-- operator-auth.ts
|   |   `-- agent-authz.ts
|   |-- services/
|   |   |-- telemetry-bus.ts
|   |   |-- trade-history.service.ts
|   |   |-- receipt.service.ts
|   |   `-- settlement.service.ts
|   |-- websocket/
|   |   |-- telemetry-server.ts
|   |   `-- redact-event.ts
|   `-- tests/
|       |-- contracts/
|       |-- integration/
|       `-- unit/
`-- Procfile

database/
|-- migrations/
|   |-- 001_create_institutions.sql
|   |-- 002_create_completed_trades.sql
|   `-- 003_create_audit_receipts.sql
|-- policies/
|   `-- row-level-security.sql
`-- seed/
    `-- development.sql

t3-enclave/
|-- package.json
|-- src/
|   |-- index.ts
|   |-- runner/
|   |   |-- create-runner.ts
|   |   |-- agent-loop.ts
|   |   `-- lifecycle.ts
|   |-- auth/
|   |   |-- agent-auth-client.ts
|   |   |-- did-registry.ts
|   |   `-- authority-claims.ts
|   |-- keys/
|   |   |-- key-generation.ts
|   |   |-- key-rotation.ts
|   |   `-- sealed-secret-maps.ts
|   |-- matching/
|   |   |-- blind-intent.ts
|   |   |-- match-contract-client.ts
|   |   `-- settlement-command.ts
|   |-- sandbox/
|   |   |-- token-balance.ts
|   |   `-- t3n-client.ts
|   `-- tests/
|       |-- auth.test.ts
|       |-- blinding.test.ts
|       `-- settlement.test.ts
```

**Structure Decision**: Use a four-part repository layout: `frontend/`, `backend/`, `database/`, and `t3-enclave/`. This keeps UI rendering, REST/WebSocket serving, persistence, and confidential agent execution independently testable and deployable. `t3-enclave/` is a separate package so Terminal 3 SDK changes do not force unrelated frontend or API refactors.

## Step-by-Step Implementation Strategy

### Milestone 1: Onboarding

Goal: admit institutions, operators, and autonomous agents without exposing trade intent.

1. Create root workspace metadata and strict TypeScript configs for `frontend/`, `backend/`, and `t3-enclave/`.
2. Add Supabase migrations for `institutions`, plus initial RLS policies that restrict institution metadata to authorized operators and backend service roles.
3. Implement backend institution and agent enrollment endpoints with no trading logic.
4. Implement `t3-enclave/src/auth/` adapter to register or look up agent DIDs, map institution authority claims, and validate agent scope before any intent submission.
5. Add dashboard shell showing secure connectivity cards only: backend status, WebSocket status, Supabase status, T3 sandbox status, and per-agent connection state.
6. Tests: authority rejection matrix, operator access isolation, dashboard accessibility, and privacy regression asserting no active order labels appear.

### Milestone 2: Encryption

Goal: establish the opaque data boundary before matching exists.

1. Implement key generation and rotation interfaces in `t3-enclave/src/keys/`.
2. Create Terminal 3 tenant private maps for sealed secrets and contract metadata with least-privilege readers/writers.
3. Add backend receipt service that stores only encrypted receipt payloads, encryption metadata, and access references.
4. Implement frontend receipt drawer that displays encrypted receipt hashes, status, creation time, and authorized retrieval state without exposing unrelated trades.
5. Add API and WebSocket redaction tests to fail if order parameters or receipt plaintext appear in emitted payloads.

### Milestone 3: Blinding Engine

Goal: accept hidden trading intent and evaluate compatibility through opaque handles only.

1. Implement `t3-enclave/src/matching/blind-intent.ts` to transform agent-submitted order parameters into a confidential T3 execution request and return only an `intent_handle`.
2. Add backend agent endpoint for opaque intent submission; request validation checks agent identity and authority, then hands encrypted payloads to `t3-enclave/`.
3. Implement match contract client for T3 TEE execution; the backend records only state transitions and non-sensitive correlation IDs.
4. Emit WebSocket telemetry states such as `agent_verified`, `intent_sealed`, `match_evaluating`, and `no_public_disclosure`; never emit asset, side, quantity, price, queue rank, or counterparty.
5. Tests: multi-institution privacy tests, telemetry snapshot tests, log scrubber tests, and race tests for simultaneous compatible matches.

### Milestone 4: Settlement

Goal: execute compatible matches, update balances, write completed history, and generate encrypted receipts.

1. Implement settlement command builder in `t3-enclave/` that receives only T3 match outcomes and produces an atomic settlement instruction.
2. Add backend settlement service that records completed trades in Supabase only after both sides settle.
3. Add `completed_trades` and `audit_receipts` migrations, RLS, and read APIs scoped to the participating institution.
4. Complete dashboard historical trade table and encrypted receipt drawer.
5. Add failure handling for insufficient balance, revoked authority, expired intent, T3 token exhaustion, and retryable T3 consensus conflicts.
6. Tests: settlement atomicity, receipt authorization, completed trade isolation, WebSocket redaction, and Playwright end-to-end privacy workflow.

## Database Schema

Supabase PostgreSQL stores durable business records after privacy filtering. It must not store active order books or raw hidden intent parameters.

### `institutions`

```sql
create table institutions (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  display_name text not null,
  status text not null check (status in ('pending', 'active', 'suspended', 'closed')),
  t3_tenant_did text not null unique,
  settlement_profile_ref text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `completed_trades`

```sql
create table completed_trades (
  id uuid primary key default gen_random_uuid(),
  trade_ref text not null unique,
  buy_institution_id uuid not null references institutions(id),
  sell_institution_id uuid not null references institutions(id),
  asset_code_ciphertext text not null,
  quantity_ciphertext text not null,
  execution_price_ciphertext text not null,
  settlement_status text not null check (settlement_status in ('settled', 'failed', 'reversed')),
  settled_at timestamptz not null,
  t3_execution_ref text not null,
  created_at timestamptz not null default now()
);
```

### `audit_receipts`

```sql
create table audit_receipts (
  id uuid primary key default gen_random_uuid(),
  completed_trade_id uuid not null references completed_trades(id) on delete cascade,
  institution_id uuid not null references institutions(id),
  receipt_ciphertext text not null,
  receipt_hash text not null,
  key_version text not null,
  t3_attestation_ref text not null,
  access_scope text not null check (access_scope in ('buyer', 'seller', 'regulatory_export')),
  created_at timestamptz not null default now(),
  opened_at timestamptz
);
```

## Terminal 3 Integration Layer

`t3-enclave/` owns all ADK and Agent Auth SDK calls.

1. **Runner instantiation**: `create-runner.ts` creates a Terminal 3 ADK client using backend-provided environment values, validates network configuration, opens the authenticated encrypted session, and returns a runner object consumed by `agent-loop.ts`.
2. **Tenant identity**: during onboarding, `did-registry.ts` uses the ADK tenant client to claim or fetch the institution tenant DID and records the DID in `institutions.t3_tenant_did`.
3. **Agent identity and authority**: `agent-auth-client.ts` wraps the Agent Auth SDK. It registers agent identity, binds the agent DID to institution-scoped authority claims, and exposes `assertAuthority(agentDid, requestedAction, policyHash)` for backend and agent-loop use.
4. **Key generation**: `key-generation.ts` creates per-institution envelope keys for receipt encryption metadata, while private execution secrets are written to Terminal 3 tenant private maps through `sealed-secret-maps.ts`.
5. **T3 private maps**: `sealed-secret-maps.ts` creates tenant maps such as `secrets`, `contract-config`, and `authority-claims` with explicit readers and writers for the matching or settlement contract only.
6. **T3 token sandbox**: `token-balance.ts` checks the DID token balance before contract registration and execution, records metering failures as private operational events, and applies bounded retries for non-committed write conflicts.
7. **TEE contract execution**: `match-contract-client.ts` publishes or references the matching contract, submits encrypted intent payloads, and receives only encrypted or opaque match outcomes. Backend receives `intent_handle`, `execution_ref`, and state labels, not order parameters.
8. **Settlement flow**: `settlement-command.ts` converts successful match outcomes into a settlement instruction, verifies authority has not been revoked, and returns a completed settlement reference for backend persistence.
9. **SDK instability boundary**: Terminal 3 docs identify `agent-auth` host capability as coming soon, so all Agent Auth calls stay behind `agent-auth-client.ts`; if the SDK surface changes, only this adapter and its tests should change.

## Telemetry & State Strategy

WebSockets broadcast operational telemetry to authenticated operators. Events are intentionally low entropy and never carry active order data.

- Frontend connects to `wss://<backend>/ws/telemetry` after operator authentication.
- Backend subscribes the socket to the operator's institution channel only.
- `telemetry-bus.ts` accepts internal state updates from backend services and `t3-enclave/`.
- `redact-event.ts` enforces an allowlist before emission: `event_id`, `institution_id`, `agent_id`, `status`, `phase`, `severity`, `timestamp`, `correlation_ref`, and `receipt_ref` when completed.
- Disallowed fields include `asset`, `side`, `quantity`, `price`, `counterparty`, `queue_depth`, `rank`, `match_score`, `raw_payload`, `plaintext`, `contract_args`, and `secret`.
- Frontend renders connection indicators and encrypted processing labels: `Secure channel active`, `Agent verified`, `Intent sealed`, `Encrypted evaluation`, `Settlement finalized`, `Receipt available`.
- Empty states are generic: "No completed trades in this period" rather than "No active orders."
- Errors are bucketed as `authorization_failed`, `token_metering_failed`, `settlement_failed`, or `service_unavailable` without raw exception messages.

## Complexity Tracking

No constitution violations. The four top-level packages are justified by deployment and security boundaries: Vercel frontend, Heroku backend, Supabase database, and Terminal 3 confidential agent integration.
