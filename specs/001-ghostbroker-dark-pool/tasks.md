# Tasks: GhostBroker Institutional Dark Pool

**Input**: Design documents from `/specs/001-ghostbroker-dark-pool/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi.yaml, contracts/websocket-events.md, quickstart.md

**Tests**: Tests are mandatory per the GhostBroker Constitution. Each user story includes contract, integration, unit, and privacy regression tasks before implementation tasks.

**Organization**: Tasks are grouped by phase and user story to support slow, incremental delivery without code drift.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other tasks in the same phase because it touches different files or has no dependency on incomplete tasks.
- **[Story]**: Maps a task to a user story from `spec.md`.
- Every task includes a concrete file path.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the monorepo structure, strict TypeScript baseline, local scripts, and deployment configuration templates.

- [X] T001 Create root npm workspace manifest with `frontend`, `backend`, and `t3-enclave` workspaces in `package.json`
- [X] T002 Create root TypeScript shared compiler settings in `tsconfig.base.json`
- [X] T003 Create root test workspace configuration in `vitest.workspace.ts`
- [X] T004 Create root lint configuration for strict TypeScript and React in `eslint.config.js`
- [X] T005 Create root formatting configuration in `.prettierrc.json`
- [X] T006 Create root ignore rules for Node, build, coverage, env, and local Supabase artifacts in `.gitignore`
- [X] T007 Create frontend package manifest with React, Vite, TypeScript, Vitest, React Testing Library, and Playwright scripts in `frontend/package.json`
- [X] T008 Create frontend Vite configuration in `frontend/vite.config.ts`
- [X] T009 Create frontend TypeScript app configuration in `frontend/tsconfig.json`
- [X] T010 Create frontend test setup for jest-dom matchers in `frontend/src/test/setup.ts`
- [X] T011 Create frontend HTML entry point in `frontend/index.html`
- [X] T012 Create backend package manifest with Express, WebSocket, Supabase, Supertest, and Vitest scripts in `backend/package.json`
- [X] T013 Create backend TypeScript configuration in `backend/tsconfig.json`
- [X] T014 Create backend Vitest configuration in `backend/vitest.config.ts`
- [X] T015 Create Heroku process declaration for the API server in `backend/Procfile`
- [X] T016 Create T3 enclave package manifest with TypeScript, Vitest, and sandbox check scripts in `t3-enclave/package.json`
- [X] T017 Create T3 enclave TypeScript configuration in `t3-enclave/tsconfig.json`
- [X] T018 Create T3 enclave Vitest configuration in `t3-enclave/vitest.config.ts`
- [X] T019 Create database migration directory marker in `database/migrations/.gitkeep`
- [X] T020 Create database policy directory marker in `database/policies/.gitkeep`
- [X] T021 Create database seed directory marker in `database/seed/.gitkeep`
- [X] T022 Create Playwright configuration for dashboard privacy checks in `playwright.config.ts`
- [X] T023 Create local environment variable template for frontend values in `frontend/.env.example`
- [X] T024 Create local environment variable template for backend values in `backend/.env.example`
- [X] T025 Create local environment variable template for T3 enclave values in `t3-enclave/.env.example`
- [X] T026 Create repository README with workspace commands and privacy warning in `README.md`

**Checkpoint**: Workspaces install, typecheck, and test commands are defined, even if implementation tests fail until later phases.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build shared primitives that every user story depends on. No user story implementation should begin until this phase is complete.

- [X] T027 Create backend environment loader with required variable validation in `backend/src/config/env.ts`
- [X] T028 Create backend typed error model with public redaction messages in `backend/src/errors/public-error.ts`
- [X] T029 Create backend request correlation middleware in `backend/src/middleware/correlation-id.ts`
- [X] T030 Create backend JSON body, CORS, and security middleware registration in `backend/src/app.ts`
- [X] T031 Create backend HTTP server entry point with graceful shutdown in `backend/src/server.ts`
- [X] T032 Create backend health route returning backend, Supabase, WebSocket, and T3 status buckets in `backend/src/api/health.routes.ts`
- [X] T033 Create backend Supabase service client wrapper in `backend/src/services/supabase-client.ts`
- [X] T034 Create backend structured logger that redacts forbidden order fields in `backend/src/logging/logger.ts`
- [X] T035 Create backend forbidden-field scanner utility for privacy tests in `backend/src/privacy/forbidden-fields.ts`
- [X] T036 Create backend telemetry event type definitions in `backend/src/websocket/telemetry-event.ts`
- [X] T037 Create backend telemetry redactor allowlist in `backend/src/websocket/redact-event.ts`
- [X] T038 Create backend telemetry bus abstraction in `backend/src/services/telemetry-bus.ts`
- [X] T039 Create backend WebSocket telemetry server shell in `backend/src/websocket/telemetry-server.ts`
- [X] T040 Create frontend design token stylesheet with dashboard color, spacing, typography, and state tokens in `frontend/src/styles/theme.css`
- [X] T041 Create frontend dashboard layout stylesheet with responsive grid rules in `frontend/src/styles/dashboard.css`
- [X] T042 Create frontend API client with typed redacted error handling in `frontend/src/services/api-client.ts`
- [X] T043 Create frontend WebSocket telemetry client with reconnect policy in `frontend/src/services/telemetry-client.ts`
- [X] T044 Create frontend route shell in `frontend/src/app/routes.tsx`
- [X] T045 Create frontend app entry with CSS imports and dashboard route in `frontend/src/app/App.tsx`
- [X] T046 Create frontend main bootstrap file in `frontend/src/main.tsx`
- [X] T047 Create T3 enclave public exports for runner, auth, keys, matching, and settlement modules in `t3-enclave/src/index.ts`
- [X] T048 Create production T3 network client interface and ADK-backed implementation in `t3-enclave/src/sandbox/t3n-client.ts`
- [X] T049 Create production T3 token balance interface and sandbox-backed implementation in `t3-enclave/src/sandbox/token-balance.ts`
- [X] T050 Create T3 runner factory interface with dependency injection in `t3-enclave/src/runner/create-runner.ts`
- [X] T051 Create T3 runner lifecycle state model in `t3-enclave/src/runner/lifecycle.ts`
- [X] T052 Create foundational privacy tests for backend logger and telemetry redaction in `backend/src/tests/unit/privacy-redaction.test.ts`

**Checkpoint**: Backend can start with health and redacted telemetry primitives, frontend can render an empty shell, and T3 enclave exposes typed production adapters.

---

## Phase 3: User Story 1 - Admit Authorized Trading Agents (Priority: P1) MVP

**Goal**: Institutions can onboard and agents can prove identity and authority before any trading activity is allowed.

**Independent Test**: Enroll an institution and test valid, expired, revoked, and over-scoped agent authority. Only the valid agent is admitted and no hidden order activity is revealed.

### Tests for User Story 1 (MANDATORY)

- [X] T053 [P] [US1] Add contract tests for `POST /api/institutions` from `contracts/openapi.yaml` in `backend/src/tests/contracts/institutions.contract.test.ts`
- [X] T054 [P] [US1] Add contract tests for `POST /api/agents/admit` success and redacted rejection responses in `backend/src/tests/contracts/agents-admit.contract.test.ts`
- [X] T055 [P] [US1] Add integration test for institution onboarding and T3 DID assignment in `backend/src/tests/integration/institution-onboarding.test.ts`
- [X] T056 [P] [US1] Add integration test for valid, expired, revoked, and over-scoped agent admission in `backend/src/tests/integration/agent-admission.test.ts`
- [X] T057 [P] [US1] Add T3 tenant DID session and identity resolution tests in `t3-enclave/src/tests/auth-did-registry.test.ts`
- [X] T058 [P] [US1] Add T3 agent delegation adapter tests for dashboard-provisioned grants, programmatic grant verification when available, and fail-closed rejection cases in `t3-enclave/src/tests/auth-agent-client.test.ts`
- [X] T059 [P] [US1] Add authority claims unit tests for asset, side, size, price, time, and settlement scope checks in `t3-enclave/src/tests/auth-authority-claims.test.ts`
- [ ] T060 [P] [US1] Add frontend dashboard accessibility test for secure status landmarks in `frontend/src/test/dashboard-accessibility.test.tsx`
- [ ] T061 [P] [US1] Add frontend privacy test proving onboarding screens do not contain active order language in `frontend/src/test/privacy-redaction.test.tsx`

### Implementation for User Story 1

- [X] T062 [P] [US1] Create institutions migration from the data model in `database/migrations/001_create_institutions.sql`
- [X] T063 [P] [US1] Create institution row-level security policies for service-role writes and institution-scoped reads in `database/policies/001_institutions_rls.sql`
- [X] T064 [P] [US1] Create development seed institutions with non-sensitive sample metadata in `database/seed/development.sql`
- [X] T065 [P] [US1] Create backend institution types and validation schemas in `backend/src/models/institution.ts`
- [X] T066 [P] [US1] Create backend agent admission types and validation schemas in `backend/src/models/agent.ts`
- [X] T067 [P] [US1] Create production operator authentication middleware with institution scoping in `backend/src/auth/operator-auth.ts`
- [X] T068 [P] [US1] Create agent authorization facade that delegates to T3 enclave in `backend/src/auth/agent-authz.ts`
- [X] T069 [US1] Implement institution service for creating profiles and resolving T3 tenant DID references in `backend/src/services/institution.service.ts`
- [X] T070 [US1] Implement agent service for admission, revocation checks, dashboard-provisioned grant references, and authority reference generation in `backend/src/services/agent.service.ts`
- [X] T071 [US1] Implement institution routes for `POST /api/institutions` in `backend/src/api/institutions.routes.ts`
- [X] T072 [US1] Implement agent admission route for `POST /api/agents/admit` in `backend/src/api/agents.routes.ts`
- [X] T073 [US1] Register institution and agent routes in `backend/src/app.ts`
- [X] T074 [US1] Implement T3 tenant DID lookup and tenant registration adapter using ADK session identity, without relying on the coming-soon `did-registry` Host API, in `t3-enclave/src/auth/did-registry.ts`
- [X] T075 [US1] Implement T3 agent delegation adapter that verifies dashboard-provisioned grants, uses a real programmatic delegation API only if Terminal 3 exposes one, and fails closed when grant verification is unavailable in `t3-enclave/src/auth/agent-auth-client.ts`
- [X] T076 [US1] Implement authority claim parser and policy hash verifier in `t3-enclave/src/auth/authority-claims.ts`
- [X] T077 [US1] Implement agent loop admission lifecycle for verified and rejected agents in `t3-enclave/src/runner/agent-loop.ts`
- [ ] T078 [P] [US1] Create secure metric card component for connection status values in `frontend/src/components/SecureMetric.tsx`
- [ ] T079 [P] [US1] Create agent connection grid component with no order fields in `frontend/src/components/AgentConnectionGrid.tsx`
- [ ] T080 [P] [US1] Create telemetry hook for agent connection and admission events in `frontend/src/hooks/useConnectionTelemetry.ts`
- [ ] T081 [US1] Create dashboard shell that renders secure connectivity cards in `frontend/src/app/App.tsx`
- [X] T082 [US1] Add US1 isolated test database seed builders for institutions and agent admission in `backend/src/tests/data/us1-seed-builders.ts`
- [X] T083 [US1] Verify US1 tests fail before implementation and pass after implementation using `backend/package.json`
- [ ] T084 [US1] Verify US1 frontend tests fail before implementation and pass after implementation using `frontend/package.json`

**Checkpoint**: User Story 1 is independently usable as an MVP for institution onboarding and agent admission.

---

## Phase 4: User Story 2 - Submit Hidden Block Trading Intent (Priority: P2)

**Goal**: Authorized agents submit hidden block trading intent through opaque encrypted envelopes, and no non-owner participant can see active order details.

**Independent Test**: Submit multiple encrypted buy and sell intents from different institutions and verify non-owners can see neither active order details nor queue indicators.

### Tests for User Story 2 (MANDATORY)

- [ ] T085 [P] [US2] Add contract tests for `POST /api/agents/intents` encrypted envelope acceptance in `backend/src/tests/contracts/agents-intents.contract.test.ts`
- [ ] T086 [P] [US2] Add contract tests proving `POST /api/agents/intents` rejects plaintext asset, side, quantity, and price fields in `backend/src/tests/contracts/agents-intents-privacy.contract.test.ts`
- [ ] T087 [P] [US2] Add integration test for authorized encrypted intent submission returning only an opaque handle in `backend/src/tests/integration/hidden-intent-submission.test.ts`
- [ ] T088 [P] [US2] Add integration test for over-scoped intent rejection without hidden queue disclosure in `backend/src/tests/integration/hidden-intent-rejection.test.ts`
- [ ] T089 [P] [US2] Add telemetry redaction test for `intent_received`, `intent_sealed`, and `encrypted_evaluation` events in `backend/src/tests/integration/telemetry-intent-redaction.test.ts`
- [ ] T090 [P] [US2] Add T3 blind intent unit tests for encrypted payload to opaque handle conversion in `t3-enclave/src/tests/blinding.test.ts`
- [ ] T091 [P] [US2] Add T3 private map tests for explicit readers and writers in `t3-enclave/src/tests/sealed-secret-maps.test.ts`
- [ ] T092 [P] [US2] Add T3 key generation and key rotation tests in `t3-enclave/src/tests/key-generation.test.ts`
- [ ] T093 [P] [US2] Add frontend telemetry rendering test for encrypted processing indicators only in `frontend/src/test/processing-status.test.tsx`
- [ ] T094 [P] [US2] Add frontend privacy regression test blocking active queue, price, quantity, and counterparty labels in `frontend/src/test/privacy-redaction.test.tsx`

### Implementation for User Story 2

- [ ] T095 [P] [US2] Create hidden intent request and response types in `backend/src/models/hidden-intent.ts`
- [ ] T096 [P] [US2] Create backend encrypted envelope validator that rejects plaintext trading fields in `backend/src/validation/encrypted-intent.schema.ts`
- [ ] T097 [P] [US2] Create T3 key generation module for per-institution envelope metadata in `t3-enclave/src/keys/key-generation.ts`
- [ ] T098 [P] [US2] Create T3 key rotation module with key version output in `t3-enclave/src/keys/key-rotation.ts`
- [ ] T099 [P] [US2] Create T3 sealed secret map module for private tenant maps in `t3-enclave/src/keys/sealed-secret-maps.ts`
- [ ] T100 [US2] Implement T3 blind intent transformation returning `intent_handle` only in `t3-enclave/src/matching/blind-intent.ts`
- [ ] T101 [US2] Implement T3 token preflight check before hidden intent processing in `t3-enclave/src/sandbox/token-balance.ts`
- [ ] T102 [US2] Implement backend hidden intent service that validates authority and calls T3 blinding in `backend/src/services/hidden-intent.service.ts`
- [ ] T103 [US2] Implement `POST /api/agents/intents` route in `backend/src/api/agents.routes.ts`
- [ ] T104 [US2] Add telemetry state publishing for `intent_received`, `intent_sealed`, and `encrypted_evaluation` in `backend/src/services/hidden-intent.service.ts`
- [ ] T105 [US2] Extend backend WebSocket redactor to block plaintext and forbidden trading fields in `backend/src/websocket/redact-event.ts`
- [ ] T106 [US2] Add backend log-scrubbing tests for hidden intent request handling in `backend/src/tests/unit/logger-hidden-intent.test.ts`
- [ ] T107 [P] [US2] Create frontend processing status rail component in `frontend/src/components/ProcessingStatusRail.tsx`
- [ ] T108 [P] [US2] Create frontend status label mapper for allowed telemetry phases in `frontend/src/services/telemetry-labels.ts`
- [ ] T109 [US2] Extend frontend telemetry hook to consume encrypted processing phases in `frontend/src/hooks/useConnectionTelemetry.ts`
- [ ] T110 [US2] Add processing status rail to the dashboard without queue counts in `frontend/src/app/App.tsx`
- [ ] T111 [US2] Add generic empty state copy for encrypted processing in `frontend/src/components/ProcessingStatusRail.tsx`
- [ ] T112 [US2] Add US2 isolated encrypted-intent test data builders with no plaintext fields in `backend/src/tests/data/us2-encrypted-intent-builders.ts`
- [ ] T113 [US2] Add multi-institution privacy test data builders proving unrelated operators receive no queue signal in `backend/src/tests/data/multi-institution-builders.ts`
- [ ] T114 [US2] Verify backend US2 contract tests fail before implementation and pass after implementation using `backend/package.json`
- [ ] T115 [US2] Verify T3 enclave US2 tests fail before implementation and pass after implementation using `t3-enclave/package.json`
- [ ] T116 [US2] Verify frontend US2 tests fail before implementation and pass after implementation using `frontend/package.json`
- [ ] T117 [US2] Document hidden intent privacy boundary in `docs/privacy/hidden-intent-boundary.md`
- [ ] T118 [US2] Add forbidden field audit checklist for intent payloads in `docs/privacy/forbidden-fields.md`
- [ ] T119 [US2] Update quickstart validation steps for encrypted intent submission in `specs/001-ghostbroker-dark-pool/quickstart.md`

**Checkpoint**: User Story 2 accepts hidden intent through opaque encrypted envelopes and emits only redacted processing telemetry.

---

## Phase 5: User Story 3 - Execute and Settle Matched Trades Silently (Priority: P3)

**Goal**: Compatible hidden buy and sell parameters execute and settle automatically, update balances atomically, and produce completed trade records and receipts.

**Independent Test**: Submit compatible encrypted intents, confirm automatic execution, verify both balances update, and verify completed trade records are written only after settlement.

### Tests for User Story 3 (MANDATORY)

- [ ] T120 [P] [US3] Add integration test for compatible match settlement and completed trade persistence in `backend/src/tests/integration/settlement-success.test.ts`
- [ ] T121 [P] [US3] Add integration test for failed settlement with no one-sided balance update in `backend/src/tests/integration/settlement-atomicity.test.ts`
- [ ] T122 [P] [US3] Add integration test for revoked authority before settlement in `backend/src/tests/integration/settlement-revoked-authority.test.ts`
- [ ] T123 [P] [US3] Add integration test for expired intent before settlement in `backend/src/tests/integration/settlement-expired-intent.test.ts`
- [ ] T124 [P] [US3] Add integration test for T3 token exhaustion bucketed as redacted telemetry in `backend/src/tests/integration/settlement-token-exhaustion.test.ts`
- [ ] T125 [P] [US3] Add T3 match contract client tests for opaque match outcomes in `t3-enclave/src/tests/match-contract-client.test.ts`
- [ ] T126 [P] [US3] Add T3 settlement command tests for successful, failed, and retryable outcomes in `t3-enclave/src/tests/settlement.test.ts`
- [ ] T127 [P] [US3] Add database migration test for completed trade constraints in `backend/src/tests/integration/completed-trades-schema.test.ts`
- [ ] T128 [P] [US3] Add database migration test for audit receipt constraints in `backend/src/tests/integration/audit-receipts-schema.test.ts`
- [ ] T129 [P] [US3] Add WebSocket test for settlement telemetry without trade plaintext in `backend/src/tests/integration/telemetry-settlement-redaction.test.ts`
- [ ] T130 [P] [US3] Add REST contract test for `GET /api/trades/completed` scoped results in `backend/src/tests/contracts/completed-trades.contract.test.ts`
- [ ] T131 [P] [US3] Add REST contract test for `GET /api/receipts/{receiptId}` authorization and encrypted payload shape in `backend/src/tests/contracts/receipts.contract.test.ts`

### Implementation for User Story 3

- [ ] T132 [P] [US3] Create completed trades migration from the data model in `database/migrations/002_create_completed_trades.sql`
- [ ] T133 [P] [US3] Create audit receipts migration from the data model in `database/migrations/003_create_audit_receipts.sql`
- [ ] T134 [P] [US3] Create completed trades row-level security policies in `database/policies/002_completed_trades_rls.sql`
- [ ] T135 [P] [US3] Create audit receipts row-level security policies in `database/policies/003_audit_receipts_rls.sql`
- [ ] T136 [P] [US3] Create backend completed trade model and validation types in `backend/src/models/completed-trade.ts`
- [ ] T137 [P] [US3] Create backend audit receipt model and validation types in `backend/src/models/audit-receipt.ts`
- [ ] T138 [P] [US3] Create backend balance update command types in `backend/src/models/balance.ts`
- [ ] T139 [US3] Implement T3 match contract client with opaque execution references in `t3-enclave/src/matching/match-contract-client.ts`
- [ ] T140 [US3] Implement T3 settlement command builder with authority recheck in `t3-enclave/src/matching/settlement-command.ts`
- [ ] T141 [US3] Implement backend settlement service with atomic completed trade and receipt write orchestration in `backend/src/services/settlement.service.ts`
- [ ] T142 [US3] Implement backend trade history service scoped to authenticated institution in `backend/src/services/trade-history.service.ts`
- [ ] T143 [US3] Implement backend receipt service for encrypted receipt persistence and retrieval in `backend/src/services/receipt.service.ts`
- [ ] T144 [US3] Implement completed trades route for `GET /api/trades/completed` in `backend/src/api/trades.routes.ts`
- [ ] T145 [US3] Implement receipt route for `GET /api/receipts/:receiptId` in `backend/src/api/receipts.routes.ts`
- [ ] T146 [US3] Register trade and receipt routes in `backend/src/app.ts`
- [ ] T147 [US3] Publish settlement telemetry phases without trade plaintext in `backend/src/services/settlement.service.ts`
- [ ] T148 [US3] Add bounded retry handling for T3 consensus conflicts in `t3-enclave/src/runner/lifecycle.ts`
- [ ] T149 [US3] Add T3 token metering failure mapping to redacted backend errors in `backend/src/services/settlement.service.ts`
- [ ] T150 [US3] Add settlement test data builders for buyer, seller, encrypted trade fields, and receipts in `backend/src/tests/data/us3-settlement-builders.ts`
- [ ] T151 [US3] Verify backend US3 tests fail before implementation and pass after implementation using `backend/package.json`
- [ ] T152 [US3] Verify T3 enclave US3 tests fail before implementation and pass after implementation using `t3-enclave/package.json`
- [ ] T153 [US3] Add settlement audit event emission for match, settlement, balance, and receipt steps in `backend/src/services/settlement.service.ts`
- [ ] T154 [US3] Update quickstart validation steps for settlement and receipt creation in `specs/001-ghostbroker-dark-pool/quickstart.md`

**Checkpoint**: User Story 3 settles compatible matches and writes completed history plus encrypted receipts without exposing active order details.

---

## Phase 6: User Story 4 - Track Secure Activity Without Exposing the Queue (Priority: P4)

**Goal**: Operators can monitor secure connections, completed trades, and encrypted receipts from a polished dashboard while active hidden orders remain masked.

**Independent Test**: Connect agents, complete trades, and review the dashboard as participating and unrelated institutions. Only permitted statuses, completed trade records, and encrypted receipt data appear.

### Tests for User Story 4 (MANDATORY)

- [ ] T155 [P] [US4] Add frontend test for agent connection grid rendering secure statuses only in `frontend/src/test/agent-connection-grid.test.tsx`
- [ ] T156 [P] [US4] Add frontend test for completed trades table rendering encrypted fields and receipt links in `frontend/src/test/completed-trades-table.test.tsx`
- [ ] T157 [P] [US4] Add frontend test for encrypted receipt drawer authorization states in `frontend/src/test/encrypted-receipt-drawer.test.tsx`
- [ ] T158 [P] [US4] Add frontend test for generic empty completed-history state with no active queue language in `frontend/src/test/completed-history-empty-state.test.tsx`
- [ ] T159 [P] [US4] Add frontend accessibility test for dashboard heading, table, buttons, drawer, and status regions in `frontend/src/test/dashboard-accessibility.test.tsx`
- [ ] T160 [P] [US4] Add Playwright E2E test for operator status, completed trades, and receipt workflow in `tests/dashboard.spec.ts`
- [ ] T161 [P] [US4] Add Playwright E2E privacy test for unrelated institution with no trade or queue disclosure in `tests/dashboard-privacy.spec.ts`
- [ ] T162 [P] [US4] Add WebSocket contract test for `contracts/websocket-events.md` event envelopes in `backend/src/tests/contracts/websocket-events.contract.test.ts`
- [ ] T163 [P] [US4] Add frontend API client tests for completed trades and receipt retrieval in `frontend/src/test/api-client.test.ts`
- [ ] T164 [P] [US4] Add frontend telemetry client tests for reconnect and redacted event handling in `frontend/src/test/telemetry-client.test.ts`

### Implementation for User Story 4

- [ ] T165 [P] [US4] Implement completed trade history hook with scoped fetch and loading states in `frontend/src/hooks/useTradeHistory.ts`
- [ ] T166 [P] [US4] Implement receipt retrieval hook with encrypted payload states in `frontend/src/hooks/useReceipt.ts`
- [ ] T167 [P] [US4] Implement agent connection grid visual states in `frontend/src/components/AgentConnectionGrid.tsx`
- [ ] T168 [P] [US4] Implement completed trades table with encrypted asset, quantity, and price ciphertext fields in `frontend/src/components/CompletedTradesTable.tsx`
- [ ] T169 [P] [US4] Implement encrypted receipt drawer with hash, key version, and attestation reference in `frontend/src/components/EncryptedReceiptDrawer.tsx`
- [ ] T170 [P] [US4] Implement secure metric component hover and focus states in `frontend/src/components/SecureMetric.tsx`
- [ ] T171 [US4] Compose dashboard layout with connection grid, processing rail, completed trades, and receipt drawer in `frontend/src/app/App.tsx`
- [ ] T172 [US4] Add dashboard responsive layout rules for desktop and mobile in `frontend/src/styles/dashboard.css`
- [ ] T173 [US4] Add status, receipt, table, and drawer token variants in `frontend/src/styles/theme.css`
- [ ] T174 [US4] Wire frontend API client to `GET /api/trades/completed` in `frontend/src/services/api-client.ts`
- [ ] T175 [US4] Wire frontend API client to `GET /api/receipts/{receiptId}` in `frontend/src/services/api-client.ts`
- [ ] T176 [US4] Wire frontend telemetry client to WebSocket event envelope validation in `frontend/src/services/telemetry-client.ts`
- [ ] T177 [US4] Add frontend telemetry label mapping for all websocket event phases in `frontend/src/services/telemetry-labels.ts`
- [ ] T178 [US4] Add frontend contract-backed test data builders for dashboard tests in `frontend/src/test/dashboard-test-data.ts`
- [ ] T179 [US4] Add backend WebSocket institution-channel authorization in `backend/src/websocket/telemetry-server.ts`
- [ ] T180 [US4] Add backend telemetry event replay prevention with correlation IDs in `backend/src/services/telemetry-bus.ts`
- [ ] T181 [US4] Add backend receipt access audit update for `opened_at` in `backend/src/services/receipt.service.ts`
- [ ] T182 [US4] Add completed history empty response handling in `backend/src/services/trade-history.service.ts`
- [ ] T183 [US4] Add Playwright support for running against the real local backend and isolated test database in `tests/support/local-stack.ts`
- [ ] T184 [US4] Add Playwright helper for asserting forbidden order text is absent in `tests/support/privacy-assertions.ts`
- [ ] T185 [US4] Verify frontend US4 tests fail before implementation and pass after implementation using `frontend/package.json`
- [ ] T186 [US4] Verify backend US4 tests fail before implementation and pass after implementation using `backend/package.json`
- [ ] T187 [US4] Verify Playwright dashboard tests fail before implementation and pass after implementation using `package.json`
- [ ] T188 [US4] Capture dashboard visual verification notes in `docs/qa/dashboard-visual-check.md`
- [ ] T189 [US4] Update quickstart dashboard verification steps in `specs/001-ghostbroker-dark-pool/quickstart.md`
- [ ] T190 [US4] Add Vercel deployment notes for dashboard environment variables in `docs/deployment/vercel-frontend.md`

**Checkpoint**: User Story 4 provides the complete dashboard without active queue disclosure.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Harden privacy, performance, deployment, and documentation across all stories.

- [ ] T191 [P] Add full forbidden-field scan across backend test data builders and frontend snapshots in `backend/src/tests/unit/global-forbidden-field-scan.test.ts`
- [ ] T192 [P] Add full forbidden-field scan across Playwright screenshots and traces in `tests/privacy-artifact-scan.spec.ts`
- [ ] T193 [P] Add TypeScript strict typecheck script validation for all workspaces in `package.json`
- [ ] T194 [P] Add CI workflow for install, typecheck, lint, unit tests, integration tests, and Playwright tests in `.github/workflows/ci.yml`
- [ ] T195 [P] Add Heroku deployment guide with required backend variables in `docs/deployment/heroku-backend.md`
- [ ] T196 [P] Add Supabase migration and RLS deployment guide in `docs/deployment/supabase.md`
- [ ] T197 [P] Add Terminal 3 sandbox setup guide with token preflight and private map checklist in `docs/deployment/terminal3-sandbox.md`
- [ ] T198 [P] Add security architecture summary for the T3 enclave boundary in `docs/security/t3-enclave-boundary.md`
- [ ] T199 [P] Add incident response notes for leaked forbidden fields in `docs/security/privacy-incident-response.md`
- [ ] T200 [P] Add API contract drift check against `specs/001-ghostbroker-dark-pool/contracts/openapi.yaml` in `backend/src/tests/contracts/openapi-drift.test.ts`
- [ ] T201 Add production logging review to confirm no plaintext order parameters in `backend/src/logging/logger.ts`
- [ ] T202 Add WebSocket load smoke test for dashboard telemetry latency under 5 seconds in `backend/src/tests/integration/telemetry-latency.test.ts`
- [ ] T203 Add settlement timing integration test for 95 percent completion within 60 seconds using Terminal 3 sandbox execution in `backend/src/tests/integration/settlement-performance.test.ts`
- [ ] T204 Add frontend performance smoke test for dashboard initial render under 2 seconds in `tests/dashboard-performance.spec.ts`
- [ ] T205 Add frontend responsive visual checks for mobile, tablet, and desktop in `tests/dashboard-responsive.spec.ts`
- [ ] T206 Add package script to run every verification from quickstart in `package.json`
- [ ] T207 Run quickstart validation and record outcomes in `docs/qa/quickstart-validation.md`
- [ ] T208 Update feature specification if implementation discovers scope changes in `specs/001-ghostbroker-dark-pool/spec.md`
- [ ] T209 Update implementation plan with any final architecture deviations in `specs/001-ghostbroker-dark-pool/plan.md`
- [ ] T210 Review all task checkboxes and record completion evidence in `specs/001-ghostbroker-dark-pool/tasks.md`

**Checkpoint**: Cross-cutting verification proves the application meets privacy, testing, and deployment requirements.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies. Complete first to establish workspaces and scripts.
- **Phase 2 Foundational**: Depends on Phase 1. Blocks all user story work.
- **Phase 3 US1**: Depends on Phase 2. This is the MVP.
- **Phase 4 US2**: Depends on Phase 2 and uses US1 authorization components for full validation.
- **Phase 5 US3**: Depends on US2 hidden intent and T3 blinding components.
- **Phase 6 US4**: Depends on US1 telemetry foundations and gains full value after US3 completed history and receipts.
- **Phase 7 Polish**: Depends on desired user stories being complete.

### User Story Dependencies

- **US1 Admit Authorized Trading Agents**: No dependency on other user stories after Phase 2.
- **US2 Submit Hidden Block Trading Intent**: Requires US1 authority primitives and real T3-enclave authority validation for authorized submissions.
- **US3 Execute and Settle Matched Trades Silently**: Requires US2 hidden intent handles and encrypted match outcomes.
- **US4 Track Secure Activity Without Exposing the Queue**: Can start after Phase 2 with contract-backed test data builders, and final acceptance depends on US1 connection telemetry and US3 completed trade APIs.

### Within Each User Story

- Write tests first and confirm they fail.
- Implement database migrations or types before services that consume them.
- Implement T3 enclave adapters before backend services that call them.
- Implement backend services before routes.
- Implement frontend services and hooks before UI composition.
- Complete story-specific privacy checks before moving to the next story.

---

## Parallel Execution Examples

### User Story 1

```text
Parallel test tasks: T053, T054, T055, T056, T057, T058, T059, T060, T061
Parallel implementation tasks after tests: T062, T063, T064, T065, T066, T067, T068, T078, T079, T080
Sequential integration path: T069 -> T070 -> T071 -> T072 -> T073 -> T074 -> T075 -> T076 -> T077 -> T081 -> T083 -> T084
```

### User Story 2

```text
Parallel test tasks: T085, T086, T087, T088, T089, T090, T091, T092, T093, T094
Parallel implementation tasks after tests: T095, T096, T097, T098, T099, T107, T108
Sequential integration path: T100 -> T101 -> T102 -> T103 -> T104 -> T105 -> T109 -> T110 -> T114 -> T115 -> T116
```

### User Story 3

```text
Parallel test tasks: T120, T121, T122, T123, T124, T125, T126, T127, T128, T129, T130, T131
Parallel implementation tasks after tests: T132, T133, T134, T135, T136, T137, T138
Sequential integration path: T139 -> T140 -> T141 -> T142 -> T143 -> T144 -> T145 -> T146 -> T147 -> T151 -> T152
```

### User Story 4

```text
Parallel test tasks: T155, T156, T157, T158, T159, T160, T161, T162, T163, T164
Parallel implementation tasks after tests: T165, T166, T167, T168, T169, T170
Sequential integration path: T171 -> T172 -> T173 -> T174 -> T175 -> T176 -> T177 -> T185 -> T186 -> T187
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational privacy, telemetry, API, frontend shell, and T3 production adapters.
3. Complete Phase 3 US1.
4. Stop and validate institution onboarding and agent admission independently.

### Incremental Delivery

1. Add US1 for secure institution and agent admission.
2. Add US2 for hidden intent submission and privacy-safe processing telemetry.
3. Add US3 for matching, settlement, completed trade history, and encrypted receipts.
4. Add US4 for the polished dashboard experience.
5. Finish with Phase 7 hardening and deployment documentation.

### Parallel Team Strategy

1. One engineer owns frontend setup and dashboard components.
2. One engineer owns backend REST, WebSocket, and Supabase integration.
3. One engineer owns `t3-enclave/` and Terminal 3 adapters.
4. One engineer owns privacy, contract, and Playwright tests.

## Task Summary

- Total tasks: 210
- Setup tasks: 26
- Foundational tasks: 26
- US1 tasks: 32
- US2 tasks: 35
- US3 tasks: 35
- US4 tasks: 36
- Polish tasks: 20

## Notes

- Tasks marked `[P]` can be worked in parallel when prior phase dependencies are complete.
- Do not create active order book tables or persist raw hidden order parameters.
- Do not emit asset, side, quantity, price, queue rank, queue depth, or active counterparty values through REST, WebSocket, logs, screenshots, or test data builders.
- Keep all Terminal 3 SDK calls behind `t3-enclave/` adapters.
- Commit after each task or small logical group once tests pass.
