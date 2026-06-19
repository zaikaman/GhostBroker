# Terminal 3 ADK Onboarding: Doc Gaps & Bugs

**Reviewed**: 2026-06-12 → 2026-06-15
**Context**: GhostBroker production dark pool on Terminal 3 ADK / T3N / TEE contracts, DID identity, private tenant maps, token-metered execution, delegated agent authority.
**Purpose**: Capture onboarding bugs, contradictions, and doc gaps so implementation does not assume unavailable SDK behavior or rely on mocks.

## Sources

ADK overview, T3N Host API, T3N DIDs, T3N TEE node, T3N tokens, Storage Namespaces, Create Tenant KV Maps, Seed API key, Capabilities from WIT imports, Common Errors, documentation index (`docs.terminal3.io`).

## Summary

Docs are enough to design the integration boundary (TS SDK, tenant onboarding, DID, private maps, TEE contracts, WIT capabilities, token metering). They are **not** enough to ship fully automated production agent onboarding without a guarded `t3-enclave` adapter, explicit capability gating, and direct vendor confirmation. Dashboard-based agent delegation is documented, but the contract-level `agent-auth`, `did-registry`, `signing`, `outbox`, `vp`, `user-profile`, and `user-removal` host interfaces are marked `Coming soon` or `System-only`. `client.admitAgentWithDelegationCredential` (JCS / Smart VC) is gone from the SDK; the only working admit shape is `client.admitAgent({ delegationCredential })` with a W3C VC loaded from disk.

## Severity Legend

- **P0** — blocks production onboarding or causes severe privacy/security risk.
- **P1** — high risk; works around an adapter boundary.
- **P2** — slows onboarding / increases support burden.
- **P3** — clarity or example-quality.

## Findings

### T3-ONB-001 — `agent-auth` Host API is `Coming soon` (P0)
Dashboard flow exists (Agent DID + contract + functions + hosts), but the contract-level `agent-auth` host interface, `did-registry`, `signing`, `outbox`, `vp`, `user-profile`, and `user-removal` are unavailable to external contracts. Blocks fully automated production agent admission; isolation behind `t3-enclave/src/auth/agent-auth-client.ts` required, with a startup fail if the SDK surface is missing. Vendor confirmation required before launch.

### T3-ONB-002 — KV map `readers` default contradicts itself (P1)
`Create Tenant KV Maps` says omitting `readers` causes `AccessDenied`. `Storage Namespaces` says it defaults from `writers`. Always set both explicitly and add a post-create ACL verification task.

### T3-ONB-003 — Errors are human-readable substrings, not typed codes (P1)
`Common Errors` ships `detail` as a human-readable message; some auth paths carry a machine code prefix. Map to internal typed categories (`authority_denied`, `map_acl_denied`, `token_metering_failed`, `contract_version_conflict`, `contract_execution_failed`, `network_unavailable`) in `t3-enclave/src/errors/t3-error-map.ts`. Never leak raw `detail` to telemetry/frontend.

### T3-ONB-004 — No production token preflight flow (P1)
Tokens meter TEE execution and storage; failed contract calls can still be billable. Add a balance preflight before tenant onboarding, map creation, contract registration, intent execution, and settlement, with bounded retry policy and idempotency keys.

### T3-ONB-005 — Secret seeding example is not production-complete (P2)
`Seed API key` is a one-off `DUFFEL_API_KEY` example. Needs key naming, version metadata, rotation, revocation, audit records, safe logging, and startup integrity check via TEE contract health probe (not external readback).

### T3-ONB-006 — DID lifecycle / recovery is not documented (P2)
No docs on `claim()` idempotency, auth method recovery, wallet compromise recovery, tenant vs operator vs agent DID separation, or suspension effects on tokens / maps / contracts.

### T3-ONB-007 — WIT capability model is clear; review checklist is missing (P2)
No checklist for expected WIT imports by use case, how to inspect compiled WASM component imports, or how to diff capabilities between versions. Add CI task that fails on unexpected host imports.

### T3-ONB-008 — TEE attestation is described conceptually, not as a verifiable workflow (P1)
No client-side attestation verification guide (quote, evidence, binding to contract version / receipt, audit retention). Store only `t3_attestation_ref` on `audit_receipts`; do not claim production-grade verifiable settlement until this is confirmed.

### T3-ONB-009 — Contract versioning error is documented; release/rollback flow is not (P2)
No version scheme, in-flight enable/disable behavior, unregister safety for old receipts, or rollback procedure. Treat unregister as prohibited for any version referenced by completed receipts.

### T3-ONB-010 — Tail vs canonical map name is easy to misuse (P2)
Some APIs expect `z:<tid>:<tail>`, others expect the tenant-local tail; passing `z:...` to a tail API returns `canonical map name invalid`. Use branded types `TenantMapTail` and `CanonicalTenantMapName` in `t3-enclave/src/keys/map-name.ts`.

### T3-ONB-011 — Host API mixes stable and `Coming soon` capabilities in one table (P1)
Split into available / partner-only / system-only / planned. Add `Terminal3CapabilityMatrix` and fail startup if required production capabilities are missing.

### T3-ONB-012 — Outbound HTTP grant walkthrough is missing (P2)
`Common Errors` mentions `host/http.egress_denied` and a user-grant fix; no full setup / inspection / revocation walkthrough. Avoid TEE-side outbound HTTP for MVP settlement; prefer backend-controlled orchestration with opaque settlement commands.

### T3-ONB-013 — Examples are narrow, not institutional (P3)
No multi-tenant delegated-authority, private-map, confidential-matching, encrypted-output, audit-persistence, or revocation examples. Treat docs as platform primitives, not an application blueprint.

### T3-ONB-014 — Logging capability is ungated; safe-logging guidance is thin (P1)
No retention, reader roles, redaction, or forbidden-field examples. Ban logging of order params, decrypted receipt content, private map values, and contract args; restrict contract logs to opaque correlation IDs and state labels.

### T3-ONB-015 — `verifyAgentIdentity()` is not a documented SDK call (P1)
No public TS `verifyAgentIdentity(request)` method, request/response shape, or error model. Use local crypto wallet recovery only where DID/request supplies the expected address; delegate unresolved DIDs to T3 network verification; fail closed. Keep behind `t3-enclave/src/auth/agent-identity.ts`.

### T3-ONB-016 — Headless E2E / drawer state persistence is undocumented (P2)
Playwright runs have no Web3 wallet; no convention for E2E operator bypass markers (`x-operator-institution-id`, `x-operator-id`) or for persisting receipt-selection / drawer-open state across reloads. CSS opacity transitions without `visibility` toggle block Playwright clicks. Document the localStorage markers, modal/drawer persistence, and `visibility: hidden` overlay pattern.

### T3-ONB-017 — TEE contract inputs are strictly snake_case; the SDK does not translate (P1)
Host dispatch reads the `input` field of the `generic-input` envelope and JSON-parses it against the Rust `Deserialize` derive's default field names. No implicit camelCase → snake_case translation. The orchestrator originally posted camelCase, causing `seal-intent: invalid JSON input: missing field 'institution_id'`, which the typed error path misclassified as a contract-not-registered cause. Fix: translate to snake_case at the network boundary in `t3-enclave/src/matching/blind-intent.ts` and `t3-enclave/src/matching/match-contract-client.ts`; keep the public TS interface camelCase.

## Addenda

**T3-ONB-007a — Live `matching` contract registration is required** (Jun 15)
Symptom: `POST /contracts/matching/blind-intents` returns 404 `tenant contract <did>:matching not registered`, rewrapped by the SDK as 503 `t3_sdk_request_failed`, then swallowed by the orchestrator route as 400 `validation_failed: The request could not be accepted.`
Fix shipped: `BlindIntentSealFailureError` with `kind: "contract_not_registered" | "t3_request_failed" | "t3_unreachable"`; `classifyBlindIntentSealFailure(status, body)`; `POST /api/agents/intents` returns 503 `sealing_failed` with redacted `cause` for `sealing_failed` and `service_unavailable` only; `PublicError.toResponse()` exposes `cause` selectively.
Operator action: register the `matching` TEE contract on the T3N testnet tenant via `scripts/publish-matching.ts` (idempotent; bump `T3_MATCHING_CONTRACT_VERSION` for new versions), then run `scripts/verify-matching-contract.ts` to confirm `seal-intent` / `evaluate-match` return opaque handles. T3N accepts a core WASM module (`wasm32-wasip2`, `cdylib`), enforces monotonic versions, and dispatches the JSON-stringified call body as `generic-input.input`.

**Chain rail (WS2) hits T3-ONB-011 / T3-ONB-013** (Jun 15)
WS2 ships a real Sepolia ERC-20 rail. Production design needs the relayer key inside a T3 tenant TEE with a `sendTransaction`-equivalent egress — both still `Coming soon`. v1 demo holds the relayer key in backend env; on-chain calldata is a sha256 of trade fields, so the chain observer sees only the tx hash, gas, `to`, and a 32-byte blob. Production migration is a one-file swap to a tenant-TEE relayer once the host interface ships.

**WS2.5 — real on-chain relayer contract** (Jun 15)
Solidity `GhostBrokerSettlementRelayer` deployed per institution; `SepoliaErc20Rail` uses `viem.writeContract` with the relayer's `settle(bytes32,bytes32,address,address,address,address,uint256,uint256)` ABI; per-institution deposit addresses required. 7/7 Anvil integration tests pass. Remaining gap: relayer key still in backend env.

**WS2.5.6 — TEE-attested relayer signer seam** (Jun 15)
`RelayerTransactionSigner` interface with `ViemWalletRelayerSigner` (v1 demo) and `TeeAttestedRelayerSigner` (production). `app.ts` picks at boot from `SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` (T3 secret-ref → TEE signer) or the env-var key (v1). `RailSettlementProof` carries `railSignerAddress`. On-chain ABI is identical for both. Swap to T3-tenant-TEE-held key is a one-line change once the host interface ships.

## Implementation Guardrails

1. No local fake agent auth — fail setup if programmatic delegation is unavailable.
2. All T3 calls stay under `t3-enclave/`.
3. Always set private-map `readers` and `writers` explicitly; never rely on defaults.
4. No raw `detail` passthrough — map to typed internal categories and redacted dashboard messages.
5. Token preflight required before any metered onboarding, registration, matching, or settlement.
6. Capability matrix required at startup; refuse production mode if a required capability is missing.
7. No secret readback outside TEE — verify via TEE contract health checks.
8. No active order persistence in Supabase (no asset, side, qty, bid/ask, queue rank, queue depth, or active counterparty).
9. No sensitive logs — scan TEE, backend, frontend, Playwright, and CI logs for forbidden fields.
10. Completed trade receipts must carry T3 execution and attestation references before being audit-ready.

## Questions for Terminal 3

1. Programmatic agent delegation available in sandbox or production, or is the `T3N_API_KEY` claim page the only supported path?
2. Package name and version for ADK and any agent-delegation / authority client APIs.
3. Exact APIs to register an agent DID and bind delegated authority to contract/function/action scope.
4. How does authority revocation propagate to in-flight TEE contract calls?
5. `did-registry` externally available, partner-only, or system-only?
6. Which Host API capabilities are externally available in the sandbox today (signing, outbox, http, http-with-placeholders, logging, time, agent-auth)?
7. Are `readers` omitted on private maps default-deny or copied from `writers`?
8. ADK API to query T3N token balance.
9. Which operations are charged during tenant onboarding, map creation, contract registration, and contract execution?
10. What attestation evidence is returned by contract execution, and how should clients verify it?
11. Can TEE contract logs contain decrypted request parameters, and where are they retained?
12. How to roll back contract versions while preserving old receipt/audit references?
13. Are `outbox` and `signing` available for financial settlement workflows?
14. Official TypeScript example for multi-tenant delegated agent authorization.
15. Production status page or compatibility matrix for ADK, Host API, and T3N sandbox capabilities.

## Bottom Line

T3 ADK/T3N docs are enough to design GhostBroker around T3 as a confidential execution layer, but not enough to ship fully automated production agent onboarding without a guarded `t3-enclave` adapter, startup capability checks, vendor confirmation on `agent-auth` / signing / outbox, and a real `matching` TEE contract registered on the tenant. No fake authority, no local mock.
