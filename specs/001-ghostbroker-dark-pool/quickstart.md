# Quickstart: GhostBroker Implementation Plan

## Prerequisites

- Node.js 20 LTS
- Supabase project and database URL
- Terminal 3 developer credentials, tenant DID access, T3N sandbox token balance, and ADK-compatible wallet or identity material

Deployment targets such as Heroku and Vercel are not required to run the US1 MVP locally.

## Environment Variables

### Frontend

```text
VITE_API_BASE_URL=http://localhost:3001
VITE_WS_TELEMETRY_URL=ws://localhost:3001/ws/telemetry
```

### Backend

```text
NODE_ENV=development
PORT=3001
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=http://localhost:5173
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>
DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres
T3N_API_KEY=<developer-key-from-terminal3-claim-page>
T3N_ENV=testnet
T3_NETWORK_URL=
T3_TENANT_DID=
T3_MATCH_CONTRACT_ID=
RECEIPT_KEY_VERSION=
SETTLEMENT_ASSET_CODE=USDC
PORTFOLIO_SYNC_TOKEN=<internal-sync-token>
ETHERSCAN_API_KEY=<etherscan-api-key>
SEPOLIA_WBTC_CONTRACT_ADDRESS=0x29f2D40B0605204364af54EC677bD022dA425d03
SEPOLIA_USDC_CONTRACT_ADDRESS=0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8
```

`DATABASE_URL` is optional for backend runtime. It is only needed by tooling that connects directly to Postgres, such as migration workflows or future database integration tests. The MVP API uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

`T3_MATCH_CONTRACT_ID` and `RECEIPT_KEY_VERSION` are optional until the hidden-intent, settlement, and receipt phases are implemented.

### T3 Enclave

```text
T3N_API_KEY=<developer-key-from-terminal3-claim-page>
T3N_ENV=testnet
T3_NETWORK_URL=
T3_TENANT_DID=
T3_SANDBOX_TOKEN_ACCOUNT=<sandbox-token-account-or-did>
T3_MINIMUM_TOKEN_BALANCE=1
T3_ADK_ENV=sandbox
T3_AUTH_SDK_ENV=sandbox
T3_AGENT_DELEGATION_MODE=dashboard
T3_AGENT_GRANT_VERIFICATION_REQUIRED=true
T3_PRIVATE_MAP_PREFIX=ghostbroker-dev
SETTLEMENT_ASSET_CODE=USDC
PORTFOLIO_SYNC_TOKEN=<internal-sync-token>
ETHERSCAN_API_KEY=<etherscan-api-key>
SEPOLIA_WBTC_CONTRACT_ADDRESS=0x29f2D40B0605204364af54EC677bD022dA425d03
SEPOLIA_USDC_CONTRACT_ADDRESS=0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8
```

## Local Setup

```powershell
npm install
npm run build --workspaces
npm run test --workspaces
```

## Terminal 3 Setup Required For GhostBroker

Terminal 3 setup starts with the claim page. The current ADK docs say that claim flow returns a developer key, a unique opaque `did:t3n` ID, and test tokens linked to the key. The SDK setup uses `T3N_API_KEY` to derive the signing address, authenticate, and read the tenant DID back from the authenticated session. Do not invent or derive the tenant DID locally.

For the US1 MVP you need:

- Developer key: `T3N_API_KEY`.
- SDK environment: `T3N_ENV=testnet` for sandbox work.
- Optional node override: `T3_NETWORK_URL`; leave blank to use the SDK's selected environment URL.
- Optional tenant guard: `T3_TENANT_DID`; when set, startup fails if the authenticated SDK session returns a different DID.
- Test token balance: used by `npm run sandbox:check --workspace @ghostbroker/t3-enclave`.
- A signed GhostBroker delegation proof for each agent admission request. The proof wraps Terminal 3 delegation credential JCS bytes, the user signature, the agent invocation signature, nonce, request hash, and a request binding for `institutionId`, `agentDid`, `requestedAction`, and `policyHash`.

For hidden intent and settlement phases you will additionally need:

- Rust and WASI Preview 2: `rustup target add wasm32-wasip2`.
- `wasm-tools` for component inspection.
- A Rust/WASM TEE contract with `wit/world.wit` imports limited to the capabilities GhostBroker needs.
- Contract registration output: the numeric contract ID and stable tenant script name.
- Tenant KV maps such as `secrets`, `authority-claims`, and contract config maps with explicit reader/writer ACLs that include the registered contract ID.
- Agent/self grants scoped to the registered script, function names, and any required outbound hosts.

Portfolio balances are no longer seeded during wallet authentication. When `ETHERSCAN_API_KEY` and the Sepolia contract addresses are configured, the backend mirrors the connected wallet address from the auth payload during login. The internal snapshot route still exists for manual backfills or recovery through `POST /api/internal/portfolio-snapshots/:institutionId` with the `x-ghostbroker-sync-token` header. For this demo, set `SETTLEMENT_ASSET_CODE=USDC`.

Example snapshot payload:

```json
{
  "sourceRef": "custody:snapshot:2026-06-13",
  "holdings": [
    { "assetCode": "WBTC", "balance": 1.25 },
    { "assetCode": "SEPOLIAETH", "balance": 24.5 },
    { "assetCode": "USDC", "balance": 250000 }
  ]
}
```

The `POST /api/agents/admit` `authorityProof` field is a JSON string with this top-level shape:

```json
{
  "version": "ghostbroker.delegation-proof/1",
  "credentialJcs": "<base64url Terminal 3 delegation credential JCS bytes>",
  "userSignature": "<base64url 65-byte EIP-191 user signature>",
  "recoveredUserAddress": "0x...",
  "agentSignature": "<base64url 64-byte agent invocation signature>",
  "nonce": "<base64url 16-byte nonce>",
  "requestHash": "<base64url sha256 canonical request binding>",
  "request": {
    "institutionId": "<uuid>",
    "agentDid": "did:t3n:...",
    "requestedAction": "agent.admit",
    "policyHash": "<authority policy hash>"
  }
}
```

The delegation credential metadata must include `institution_id`, `agent_did`, and `policy_hash`. Startup and admission remain fail-closed if the proof cannot be verified.

## Database

```powershell
supabase db push
```

Expected MVP migrations:

- `database/migrations/001_create_institutions.sql`
- `database/migrations/002_create_agent_authority_revocations.sql`
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
- Dashboard shows backend, WebSocket, Supabase, T3 sandbox, and agent connectivity status.
- Dashboard does not show active order queue, active order counts, asset quantities, bid prices, ask prices, queue rank, or counterparty interest.

## T3 Enclave

```powershell
Set-Location t3-enclave
npm run test
npm run sandbox:check
```

Validation:

- Tenant DID can be resolved.
- Agent DID has a signed, scoped, time-bounded delegation proof.
- Agent DID can be admitted or rejected.
- T3 token balance can be checked against the configured sandbox account.

## Deployment

1. Deploy `frontend/` to Vercel with `VITE_API_BASE_URL` and `VITE_WS_TELEMETRY_URL`.
2. Deploy `backend/` to Heroku with Supabase and T3 environment variables.
3. Run Supabase migrations before enabling production traffic.
4. Validate WebSocket telemetry in production with a sandbox institution and sandbox agent configured through real T3N delegation.

## MVP Acceptance Checks

Before marking the US1 MVP complete:

- `GET /api/health` returns backend, Supabase, WebSocket, and T3 status buckets.
- `POST /api/institutions` creates an institution profile and stores the resolved T3 tenant DID.
- `POST /api/agents/admit` admits a valid signed delegation proof and rejects expired, revoked, over-scoped, or tampered proofs.
- Dashboard secure status screens render without active order language.

Hidden intent submission, settlement, completed trade history, and receipt retrieval are validated by the later story-specific checks below.

## US2 Hidden Intent Validation

After US2 implementation, validate encrypted intent submission locally:

```powershell
npm run test --workspace @ghostbroker/backend -- agents-intents
npm run test --workspace @ghostbroker/backend -- hidden-intent
npm run test --workspace @ghostbroker/t3-enclave -- blinding
```

Expected behavior:

- `POST /api/agents/intents` accepts `institutionId`, `agentDid`, `authorityRef`, and `encryptedIntentEnvelope`.
- Plaintext active trading fields such as `asset`, `side`, `quantity`, and `price` are rejected with `validation_failed`.
- Successful responses contain only `intentHandle` and `state`.
- Telemetry emits only `intent_received`, `intent_sealed`, and `encrypted_evaluation` with opaque correlation references.
- T3 enclave tests prove encrypted envelopes are converted to opaque handles only.

## US3 Settlement Validation

After US3 implementation, validate settlement and receipt persistence locally:

```powershell
npm run test --workspace @ghostbroker/backend -- settlement completed-trades-schema audit-receipts-schema completed-trades receipts telemetry-settlement
npm run test --workspace @ghostbroker/t3-enclave -- match-contract-client settlement
```

Expected behavior:

- Compatible opaque match outcomes produce completed trade records only after settlement command construction succeeds.
- Failed persistence returns `service_unavailable` and does not return a partial completed trade.
- Revoked authority, expired outcomes, and token metering failures are bucketed into redacted public errors.
- `GET /api/trades/completed` returns only authenticated-institution completed history with encrypted trade fields.
- `GET /api/receipts/{receiptId}` returns encrypted receipt data only for the receipt owner and records an access audit timestamp.
- Settlement telemetry emits only `settlement_pending`, `settlement_finalized`, `receipt_available`, and redacted failure buckets.

## US4 Dashboard Validation

After US4 implementation, validate the operator dashboard integration:

```powershell
npm run test --workspace @ghostbroker/frontend
```

Expected behavior:
- All frontend unit and accessibility tests pass.
- Completed trade history is fetched using operator context headers.
- Ciphertext fields for Asset, Quantity, and Price are rendered truncated (e.g. `t3cipher.as...sealed` or `...phertext`) to ensure zero-visibility of active values.
- Clicking "View Receipt" displays the encrypted audit receipt details inside the slide-out drawer, showing key version, attestation references, and verification proof.
- Unrelated institutions are denied receipt access with a safe redacted error display.

