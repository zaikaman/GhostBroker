# Terminal 3 ADK Onboarding Bugs and Documentation Gaps

**Date reviewed**: 2026-06-12  
**Context**: GhostBroker planning and task generation for a production-grade institutional dark pool using Terminal 3 ADK, T3N, TEE contracts, DID identity, private tenant maps, token-metered execution, and delegated agent authority.  
**Purpose**: Capture onboarding bugs, contradictions, and documentation gaps found while reviewing Terminal 3 ADK/T3N docs so implementation does not accidentally rely on assumptions, unavailable SDK behavior, or non-production substitutes.

## Sources Reviewed

- Terminal 3 ADK overview: https://docs.terminal3.io/developers/adk/overview/what-is-adk
- T3N Host API: https://docs.terminal3.io/t3n/how-t3n-works/host-api
- T3N DIDs: https://docs.terminal3.io/t3n/how-t3n-works/did
- T3N TEE node: https://docs.terminal3.io/t3n/how-t3n-works/tees
- T3N tokens: https://docs.terminal3.io/t3n/how-t3n-works/tokens
- T3N storage namespaces: https://docs.terminal3.io/t3n/how-t3n-works/z-namespace
- ADK create tenant KV maps: https://docs.terminal3.io/developers/adk/tips/create-kv-maps
- ADK seed API key: https://docs.terminal3.io/developers/adk/tips/seed-api-key
- ADK capabilities from WIT imports: https://docs.terminal3.io/developers/adk/tips/capabilities-from-wit-import
- ADK common errors: https://docs.terminal3.io/developers/adk/tips/common-errors
- Documentation index: https://docs.terminal3.io/llms.txt

## Executive Summary

The ADK documentation is enough to design the broad integration boundary: TypeScript/JavaScript SDK, tenant onboarding, DID identity, tenant KV maps, private map ACLs, TEE contract publishing/execution, WIT-based capabilities, and token-metered operations.

It is not yet enough to implement GhostBroker's agent onboarding and delegated trading authority without a guarded integration boundary. The docs do describe dashboard-based delegation to AI agents, but the Host API table marks the `agent-auth` host interface, `did-registry`, signing, user-profile, outbox, and related contract capabilities as `Coming soon` or otherwise unavailable to ordinary contracts. GhostBroker needs production-grade agent identity and authority enforcement before trading, so implementation should use a production adapter around Terminal 3 SDK calls, explicit environment gating, and direct vendor confirmation before launch.

## Severity Legend

- **P0**: Blocks production onboarding or creates a severe privacy/security risk.
- **P1**: High implementation risk; can be worked around with adapter boundaries or extra validation.
- **P2**: Documentation gap that slows onboarding or increases support burden.
- **P3**: Clarity, wording, or example-quality issue.

## Findings

### T3-ONB-001: Dashboard Agent Delegation Exists, but the `agent-auth` Host API Is Listed as Coming Soon

**Severity**: P0  
**Category**: Onboarding blocker / authority model  
**Affected docs**: Host API, Delegate Access, Delegate Access to AI Agents, ADK overview, Common Errors  

**What I found**

GhostBroker requires autonomous agents to prove identity and authority before submitting hidden trading intent. The docs include a data-owner guide for delegating access to AI agents through the T3N Dashboard: a user enters an Agent DID, selects an authorized TEE contract, optionally selects functions, and optionally configures allowed hosts. That means agent delegation is documented as a product flow.

Separately, the Host API page lists a contract host interface named `agent-auth` for updating which TEE contracts and functions an agent is authorized to invoke, and marks that interface as `Coming soon`. The same Host API table marks related contract capabilities as coming soon, including `did-registry`, `signing`, `outbox`, `vp`, `user-profile`, and `user-removal`.

The Common Errors page references an `agent_auth` grant in the outbound HTTP authorization error text. That confirms the authorization concept exists, but the reviewed public docs do not show a stable programmatic SDK/API flow equivalent to the dashboard delegation flow.

**Why this matters for GhostBroker**

Agent authority is not optional. If dashboard-only delegation is the only generally available path today, GhostBroker needs confirmation on whether production code can programmatically register agents, bind authority scopes, verify those scopes, and revoke them. If that programmatic surface is not available, onboarding cannot be fully automated in a production-ready way.

**Impact**

- Blocks fully automated production implementation of agent admission unless Terminal 3 provides a documented SDK/API path or confirms the dashboard flow is the intended onboarding path.
- Increases risk of building an incompatible adapter if the SDK surface changes.
- Makes it impossible to fully specify failure modes for revoked, expired, or over-scoped agent authority from public docs alone.

**Recommended fix for docs**

- Add a dedicated programmatic agent delegation onboarding page with:
  - current availability status
  - install package name
  - required environment variables
  - identity registration flow
  - delegated authority creation flow
  - revocation flow
  - scope model for contract/function/action permissions
  - example request/response payloads
  - error codes
  - production readiness notes

**Recommended implementation action**

- Keep all programmatic agent delegation and authority checks isolated behind `t3-enclave/src/auth/agent-auth-client.ts`.
- Do not implement local fake authority semantics.
- Add a build-time or startup check that fails if required programmatic delegation methods are unavailable or if dashboard-only setup is required.
- Require Terminal 3 confirmation before production deployment.

**Verification**

- A production onboarding test must create or resolve an agent DID, bind authority claims, admit the agent, revoke authority, and confirm revoked authority blocks new intent submission.

---

### T3-ONB-002: KV Map Reader Defaults Contradict Each Other

**Severity**: P1  
**Category**: Documentation contradiction / secret map provisioning  
**Affected docs**: Create Tenant KV Maps, Storage Namespaces  

**What I found**

The Create Tenant KV Maps page says `readers` must be set explicitly and that omitting it causes the KV governor to deny reads, making a contract's own secret read fail with `AccessDenied`.

The Storage Namespaces page says that if `readers` is omitted on map creation, it defaults from `writers`.

These two statements conflict.

**Why this matters for GhostBroker**

GhostBroker needs private maps for sealed secrets, contract configuration, authority claims, and encrypted matching state. A wrong assumption about default readers could break the first production onboarding run or, worse, grant broader read access than intended.

**Impact**

- Possible `AccessDenied` at runtime after a seemingly successful map creation.
- Possible mismatched security assumptions between implementation and actual T3N governor behavior.
- Increased risk of manual hotfixes during onboarding.

**Recommended fix for docs**

- Reconcile the two pages with the exact current behavior.
- State whether `readers` defaults to deny, defaults from writers, or varies by SDK version/network.
- Include the precise recommended production pattern for private maps.

**Recommended implementation action**

- Always set both `readers` and `writers` explicitly.
- Treat `MapAlreadyExists` as idempotent only after verifying the existing map ACL matches the expected policy.
- Add a post-create ACL verification task before writing secrets.

**Verification**

- Integration test creates a private map, writes a secret by control-plane call, executes a TEE contract that reads the secret, and verifies a non-reader contract cannot read it.

---

### T3-ONB-003: Error Handling Depends on Human-Readable Substrings

**Severity**: P1  
**Category**: SDK ergonomics / production reliability  
**Affected docs**: Common Errors  

**What I found**

The Common Errors page says errors come back as JSON-RPC `bad_request` with `{ code, detail, request_id }`, and that the SDK throws with `detail` as a human-readable message string, not a typed error object. It recommends matching on substrings, with some authentication failures carrying a machine code prefix.

**Why this matters for GhostBroker**

GhostBroker's onboarding and settlement flows need deterministic production error handling. Substring matching is brittle, especially for financial workflows where specific outcomes must map to safe states: revoked authority, expired authority, token exhaustion, map ACL mismatch, contract version conflict, and settlement failure.

**Impact**

- Fragile retry logic.
- Incorrect user-facing status buckets.
- Increased chance of leaking raw platform error text to dashboard telemetry.
- Harder auditability for failed onboarding and failed settlement.

**Recommended fix for docs**

- Define stable error codes for ADK and T3N operations.
- Provide a typed error schema for SDK exceptions.
- Document which errors are retryable, idempotent, terminal, or billable attempts.

**Recommended implementation action**

- Centralize Terminal 3 error mapping in `t3-enclave/src/errors/t3-error-map.ts`.
- Map raw errors to GhostBroker-safe categories only:
  - `authority_denied`
  - `map_acl_denied`
  - `token_metering_failed`
  - `contract_version_conflict`
  - `contract_execution_failed`
  - `network_unavailable`
- Never pass raw `detail` strings to WebSocket telemetry or the frontend.

**Verification**

- Unit tests cover every documented error substring and ensure emitted errors are redacted and typed inside GhostBroker.

---

### T3-ONB-004: Token Onboarding Lacks a Clear Production Preflight Flow

**Severity**: P1  
**Category**: Cost control / operational onboarding  
**Affected docs**: Tokens, ADK overview, documentation index  

**What I found**

The Tokens page clearly explains that T3N tokens meter TEE execution and storage, that each DID can hold a token balance, and that contract-level failures may still be charged as billable attempts. The documentation index references a Request Test Tokens page, but the reviewed public pages do not provide a complete production preflight checklist for checking balances, estimating costs, enforcing retry budgets, or preventing expensive repeated work.

**Why this matters for GhostBroker**

GhostBroker matching and settlement may be high-value and expensive. Repeated retries during onboarding or matching could consume tokens while still failing, especially if failures occur after execution starts.

**Impact**

- Production onboarding may fail late because token balance is insufficient.
- Retry loops could turn contract errors into repeated billable attempts.
- Settlement flows may become non-deterministic if token exhaustion is discovered after partial orchestration.

**Recommended fix for docs**

- Add a token preflight guide with:
  - balance query API
  - minimum balance examples for map creation, contract registration, and execution
  - charge behavior by operation
  - retry strategy
  - recommended idempotency keys
  - production alerts for low balance

**Recommended implementation action**

- Implement `t3-enclave/src/sandbox/token-balance.ts` as a real sandbox-backed balance check.
- Require balance preflight before:
  - tenant onboarding
  - private map creation
  - contract registration
  - hidden intent execution
  - settlement execution
- Add bounded retry policy with explicit attempt limits.

**Verification**

- Integration test fails fast with `token_metering_failed` before submitting expensive work when balance is below configured threshold.

---

### T3-ONB-005: Secret Seeding Example Is Useful but Not Production Complete

**Severity**: P2  
**Category**: Secret management documentation gap  
**Affected docs**: Seed API key, Create Tenant KV Maps  

**What I found**

The Seed API key page shows how to write a secret with `tenant.executeControl("map-entry-set", ...)`, using a `DUFFEL_API_KEY` example and a console log saying the API key was sealed. It explains that the control-plane write bypasses map writers ACL and that only contract code can read the key back.

The example is helpful, but it does not cover production secret lifecycle concerns.

**Why this matters for GhostBroker**

GhostBroker cannot treat sealed settlement keys, authority material, receipt keys, or private matching configuration like a one-off API key. It needs rotation, versioning, audit trails, least-privilege map policies, and startup validation.

**Impact**

- Developers may copy a minimal example into production without rotation or validation.
- Secrets may be seeded with wrong keys or wrong map names.
- Lack of key versioning can make receipt decryption and audits brittle.

**Recommended fix for docs**

- Add production secret management guidance:
  - key naming convention
  - key version metadata
  - rotation flow
  - revocation flow
  - audit records
  - safe logging guidance
  - expected behavior when a key is missing or stale

**Recommended implementation action**

- Use explicit key version fields for every receipt.
- Never log secret values or derived plaintext.
- Log only map tail, key version, and operation outcome.
- Add a startup integrity check that required secret keys exist by invoking a TEE contract health check, not by reading secrets back outside TEE.

**Verification**

- Test rotates a receipt key version and verifies old receipts remain associated with their original `key_version`.

---

### T3-ONB-006: DID Onboarding Does Not Define Lifecycle and Recovery Details

**Severity**: P2  
**Category**: Identity lifecycle documentation gap  
**Affected docs**: DIDs, ADK overview  

**What I found**

The DID page explains that every entity, including humans and AI agents, receives a `did:t3n:<unique-id>`, that it is linked to authentication methods and permissions, and that each DID can hold a token balance. The ADK overview says tenant onboarding uses `client.tenant.claim()` and `me()`.

The docs do not provide enough lifecycle detail for enterprise onboarding.

**Missing details**

- Whether `claim()` is idempotent across repeated runs.
- How to recover or rotate authentication methods.
- How to transfer operational control if the original wallet or key is compromised.
- How to distinguish tenant DID, operator DID, and agent DID in code.
- How DID suspension affects token balances, contracts, and private maps.
- How to audit DID ownership changes.

**Why this matters for GhostBroker**

Institutional onboarding needs recoverability and clear separation between institution, operator, and autonomous agent identities.

**Recommended fix for docs**

- Add an enterprise DID lifecycle page with diagrams and failure cases.
- Include examples for repeated onboarding, lost wallet, agent rotation, and suspended tenant.

**Recommended implementation action**

- Store `t3_tenant_did` on institutions.
- Treat agent DIDs as separate identities from institution tenant DID.
- Require explicit authority binding between institution and agent.
- Do not assume a DID can be replaced without migration/audit.

**Verification**

- Onboarding test reruns tenant claim safely and verifies the same institution record remains stable.

---

### T3-ONB-007: WIT Capability Model Is Clear, but Contract Build/Capability Review Needs a Checklist

**Severity**: P2  
**Category**: Contract security documentation gap  
**Affected docs**: Capabilities from WIT imports, Host API  

**What I found**

The WIT capabilities page explains that capabilities come from host interfaces imported in `world.wit`, and that there is no separate manifest. Importing `http` opts into outbound HTTP, while base worlds include KV store, logging, and tenant context.

This is clear at a concept level, but production onboarding needs an operational review checklist.

**Why this matters for GhostBroker**

The matching and settlement contract should use minimum host capabilities. A stray WIT import could broaden the contract's capability surface.

**Impact**

- Code review may miss capability expansion.
- Security reviewers may look for a manifest that does not exist.
- Contract builds may change capability posture without obvious deployment diff.

**Recommended fix for docs**

- Add a capability review checklist:
  - expected WIT imports by use case
  - how to inspect compiled WASM component imports
  - how to diff capabilities between versions
  - how Host API allowlists interact with WIT imports

**Recommended implementation action**

- Add a CI task that inspects TEE contract WIT imports and fails if unexpected capabilities appear.
- Keep matching contract on the smallest possible capability world.

**Verification**

- CI test fails when `http`, signing, or any unapproved host interface is imported by the matching contract.

---

### T3-ONB-008: TEE Attestation Is Described Conceptually but Not as a Client Verification Workflow

**Severity**: P1  
**Category**: Security proof documentation gap  
**Affected docs**: TEE Node, ADK overview  

**What I found**

The TEE Node page describes confidential, tamper-resistant, remotely attestable execution. It explains encrypted communication, authentication and attestation services, threshold encryption, and execution inside hardware-backed TEEs.

The reviewed ADK docs do not provide a concrete client-side attestation verification workflow.

**Why this matters for GhostBroker**

GhostBroker needs encrypted receipts and settlement evidence. For institutional adoption, the system should be able to show that the matching/settlement logic ran in an attested environment and that receipts reference the correct execution evidence.

**Missing details**

- What attestation object the ADK returns.
- How to validate the quote or evidence.
- How to bind attestation to a contract version.
- How to bind attestation to a completed trade receipt.
- What evidence should be retained for audits.

**Recommended fix for docs**

- Add an ADK attestation verification guide.
- Include code for verifying attestation evidence in TypeScript.
- Include guidance on storing attestation references in business records.

**Recommended implementation action**

- Store only `t3_attestation_ref` in `audit_receipts`.
- Keep attestation verification inside backend/T3 enclave services, not frontend.
- Do not claim production-grade verifiable settlement until this flow is confirmed.

**Verification**

- Settlement test verifies every completed receipt has a non-empty attestation reference tied to the T3 execution reference.

---

### T3-ONB-009: Contract Versioning Error Is Documented, but Release/Rollback Flow Is Not

**Severity**: P2  
**Category**: Deployment documentation gap  
**Affected docs**: Common Errors, ADK overview  

**What I found**

The Common Errors page documents an error when re-registering a contract with a version that is not higher than the current version. The ADK overview mentions publishing a Rust to WASM contract and lifecycle operations like enable, disable, and unregister.

The docs do not provide a release management flow.

**Why this matters for GhostBroker**

Matching and settlement contracts are safety-critical. Contract upgrades must be auditable and rollback-safe.

**Missing details**

- Recommended version scheme.
- How enable/disable interacts with in-flight executions.
- Whether unregister is safe for contracts referenced by old receipts.
- How to roll back after a bad contract publish.
- How to keep multiple versions active for receipt verification.

**Recommended fix for docs**

- Add a contract lifecycle guide covering publish, enable, disable, unregister, version bumping, rollback, and old receipt verification.

**Recommended implementation action**

- Store `t3_execution_ref` and contract version with completed trade receipts.
- Treat contract unregister as prohibited for any version referenced by completed receipts.
- Add a deployment checklist for T3 contract version bumps.

**Verification**

- Test refuses to settle if backend expected contract version differs from the enabled T3 contract version.

---

### T3-ONB-010: Tail vs Canonical Map Name Is Easy to Misuse

**Severity**: P2  
**Category**: Developer onboarding friction  
**Affected docs**: Storage Namespaces, Create Tenant KV Maps, Seed API Key  

**What I found**

The Storage Namespaces page says canonical names use `z:<tid>:<tail>`, and SDK helpers may ask only for the tenant-local tail. The Create Tenant KV Maps page similarly says the `tail` is the local name and the host stores it as `z:<tid>:<tail>`. The Common Errors page warns that passing a tail starting with `z:` causes `canonical map name invalid`.

**Why this matters for GhostBroker**

Private map naming will be used in multiple modules: secrets, authority claims, contract configuration, and matching state. A developer can easily mix canonical names and tail names in the wrong API call.

**Impact**

- Map creation failures during onboarding.
- Runtime `map not found` errors.
- Incorrect documentation or logs if canonical names and tails are mixed.

**Recommended fix for docs**

- Add an API-by-API table showing whether each method expects a tail or canonical name:
  - `tenant.maps.create`
  - `tenant.maps.update`
  - `tenant.canonicalName`
  - `tenant.executeControl("map-entry-set")`
  - contract-side `kv_store::get`

**Recommended implementation action**

- Use explicit types:
  - `TenantMapTail`
  - `CanonicalTenantMapName`
- Do not pass plain strings across T3 map APIs.

**Verification**

- Unit tests ensure canonical names cannot be passed to functions expecting a tail.

---

### T3-ONB-011: Host API Capability Availability Is Mixed With Stable Capabilities

**Severity**: P1  
**Category**: Product planning risk  
**Affected docs**: Host API  

**What I found**

The Host API page lists stable capabilities and unavailable capabilities in the same table. Several important capabilities are marked `Coming soon` or `System-only`.

**Why this matters for GhostBroker**

For a production task list, it matters which capabilities are usable by external developers today. GhostBroker's scope touches agent authority, time/clock, signing, outbox-style settlement side effects, and possibly DID registry operations. Some of those are not externally available according to the Host API table.

**Impact**

- Implementation tasks may accidentally assume unavailable host capabilities.
- Production onboarding may need Terminal 3 partner access.
- Alternative architecture may be needed for unavailable features.

**Recommended fix for docs**

- Split Host API into:
  - available to external developers
  - available by allowlist/partner access
  - system-only
  - planned/coming soon
- Add expected release status and migration notes for coming-soon capabilities.

**Recommended implementation action**

- Create a `Terminal3CapabilityMatrix` config in `t3-enclave/`.
- Fail startup if required production capabilities are not marked available.
- Avoid implementing settlement side effects through unavailable `outbox` unless Terminal 3 confirms access.

**Verification**

- Startup validation logs a redacted capability matrix and refuses production mode if required capabilities are missing.

---

### T3-ONB-012: Outbound HTTP Authorization Uses User Grants, but Grant Setup Is Not Fully Walked Through

**Severity**: P2  
**Category**: Permission onboarding gap  
**Affected docs**: Common Errors, Host API, Capabilities from WIT imports  

**What I found**

The Common Errors page mentions `host/http.egress_denied` when a host is not in the authorized host allowlist and says the fix is to add the host to the user's grant. The Host API explains `http` and `http-with-placeholders` capabilities, and the WIT page explains importing `http`.

The reviewed docs do not provide a full grant setup walkthrough.

**Why this matters for GhostBroker**

If matching or settlement contracts need to call external settlement rails, custody systems, or verification providers, egress must be explicitly authorized. Without a clear grant flow, onboarding can fail at runtime.

**Recommended fix for docs**

- Add a complete outbound HTTP grant walkthrough:
  - who grants access
  - where grant state is stored
  - how to inspect current grants
  - how to revoke grants
  - how grants relate to WIT imports and Host API allowlists

**Recommended implementation action**

- Do not rely on outbound HTTP from T3 contracts for GhostBroker MVP unless required grants are confirmed.
- Prefer backend-controlled settlement orchestration where confidential match result is returned as an opaque settlement command.

**Verification**

- If outbound HTTP is used, an integration test must verify allowed and denied host behavior using production grant APIs.

---

### T3-ONB-013: Documentation Examples Are Narrow and Do Not Cover Financial/Institutional Workflows

**Severity**: P3  
**Category**: Example coverage gap  
**Affected docs**: ADK quick tips, use cases, documentation index  

**What I found**

The reviewed ADK examples focus on narrow cases such as seeding a Duffel API key and a payroll agent page listed in navigation. They demonstrate mechanics but not institutional-grade multi-tenant authorization, audit, settlement, or privacy-preserving trading.

**Why this matters for GhostBroker**

GhostBroker has stricter requirements:

- multiple institutions
- autonomous agents
- delegated trading authority
- hidden active order state
- encrypted receipts
- completed trade auditability
- no public or cross-participant order leakage

**Recommended fix for docs**

- Add an enterprise multi-tenant example covering:
  - two tenants
  - delegated agent authority
  - private maps
  - confidential matching or workflow
  - encrypted output
  - audit reference persistence
  - revocation

**Recommended implementation action**

- Treat Terminal 3 docs as platform primitives, not a complete application blueprint.
- Keep GhostBroker privacy and authorization invariants in local tests.

**Verification**

- End-to-end test with two institutions and unrelated third institution validates no active queue leakage.

---

### T3-ONB-014: Logging Capability Exists, but Safe Logging Guidance Is Thin

**Severity**: P1  
**Category**: Privacy/security documentation gap  
**Affected docs**: Host API, TEE Node, Common Errors  

**What I found**

The Host API lists `logging` as a base capability with no gating. The docs do not provide enough guidance on what logs can leave the TEE, how logs are stored, who can read them, or how to prevent secrets/private order parameters from being logged.

**Why this matters for GhostBroker**

Logging active order parameters, matching inputs, or decrypted settlement values would violate the product's central privacy requirement.

**Impact**

- Contract developers may log decrypted values while debugging.
- Backend may forward raw platform error details into dashboard telemetry.
- Production incident response may collect sensitive traces by accident.

**Recommended fix for docs**

- Add safe logging guidance:
  - where TEE logs go
  - reader roles
  - retention model
  - redaction recommendations
  - examples of safe and unsafe logs

**Recommended implementation action**

- Ban logging of order parameters, decrypted receipt content, private map values, and raw contract arguments.
- Add forbidden-field scanners over logs and telemetry.
- Keep contract logs limited to opaque correlation IDs and state labels.

**Verification**

- Privacy test fails if logs contain asset, side, quantity, price, queue rank, counterparty, plaintext, secret, or contract args.

---

### T3-ONB-015: DID Challenge Verification API Is Not Documented as `verifyAgentIdentity()`

**Severity**: P1  
**Category**: Authentication onboarding gap  
**Affected docs**: ADK overview, T3N DIDs, Host API, Delegate Access to AI Agents  

**What I found**

GhostBroker's frontend authentication flow requires a backend-generated nonce, a wallet or DID signature, and Terminal 3 verification of the DID subject before issuing an operator session. Gemini's suggested flow names a `verifyAgentIdentity()` call inside a simulated T3 TEE context, but the reviewed local Terminal 3 docs do not document a concrete TypeScript `verifyAgentIdentity()` SDK method, request shape, response shape, or error model.

The Terminal 3 SDK does expose low-level EIP-191 recovery helpers and broader wallet/authenticator surfaces, and the docs describe DIDs and dashboard-based agent delegation. That is enough for GhostBroker to keep a guarded adapter boundary, but not enough to claim a stable production `verifyAgentIdentity()` API.

**Why this matters for GhostBroker**

Without an official DID challenge verification API, implementers may accidentally conflate wallet signature recovery, DID resolution, dashboard delegation, and TEE identity verification. Those are related but distinct checks.

**Recommended fix for docs**

- Add a DID challenge authentication guide covering:
  - backend nonce generation requirements
  - browser wallet signing format
  - DID-to-wallet or DID-document verification
  - TEE-backed verification method name
  - success and rejection response schema
  - replay protection and nonce expiration
  - production error codes

**Recommended implementation action**

- Keep GhostBroker's verification behind `t3-enclave/src/auth/agent-identity.ts`.
- Use local cryptographic wallet recovery only for wallet-backed DIDs where the DID or request provides the expected address.
- Delegate unresolved DID formats to a Terminal 3 network verification endpoint through the adapter.
- Fail closed when neither local cryptographic verification nor Terminal 3 verification succeeds.

**Verification**

- Auth tests must prove challenges are one-time, expired challenges fail, invalid signatures fail, and production API routes require a bearer session rather than unsigned institution headers.

---

### T3-ONB-016: Headless E2E Browser Testing and Drawer State Persistence Guidelines

**Severity**: P2  
**Category**: QA / E2E Testing gap  
**Affected docs**: Testing & Local Stack Integration, Operator Authentication System, Telemetry Integration  

**What I found**

Headless E2E test runners (like Playwright) running in automated pipelines do not have access to Web3 browser wallets (like MetaMask) to solve wallet challenge prompts. The local documentation does not specify how automation should authenticate as institutional operators to execute console/observatory tasks.

Additionally, E2E tests verifying credential rotations or unauthorized receipt access often perform page reloads in the middle of validation. If critical UI states (such as active receipt selection and drawer open state) are kept purely in transient React component state, they are wiped on reload, breaking E2E verification flows. Furthermore, CSS opacity transitions on overlays without visibility state toggling cause automated hit-test click blockers.

**Why this matters for GhostBroker**

Without a standardized testing bypass and state persistence mechanism, operators cannot build robust, repeatable E2E tests for secure dashboard features like attestation receipts or enclaved trade metrics.

**Recommended fix for docs**

- Add guidelines for E2E testing operator console pages:
  - Documenting E2E local storage markers (`x-operator-institution-id` and `x-operator-id`) that the frontend client API and state hooks can detect to supply a mock session.
  - Recommending local storage or hash-based persistence for modal/drawer states to survive page reloads during multi-step E2E tests.
  - Outlining CSS transition guidelines requiring visibility transitions or `display: none` to avoid overlay pointer-event interception.

**Recommended implementation action**

- Allow E2E bypass in `api-client.ts`'s session parser by checking for operator local storage context when a wallet bearer session is absent.
- Persist receipt selection and drawer open states to local storage on value update, and restore them during component mount.
- Add `visibility: hidden;` to `.drawer-backdrop` transitions and use `dispatchEvent('click')` in Playwright for robust element clicks.

---

## Implementation Guardrails for GhostBroker

These guardrails should be treated as non-negotiable until Terminal 3 fills the relevant documentation gaps or confirms private integration details.

1. **No local fake Agent Auth**: Do not simulate authority in production code. If programmatic agent delegation is unavailable and dashboard setup is required, fail setup clearly and document the manual prerequisite.
2. **Adapter boundary only**: All Terminal 3 calls must remain under `t3-enclave/`.
3. **Explicit private map ACLs**: Always set readers and writers; never rely on defaults.
4. **No raw error passthrough**: Map Terminal 3 errors into internal typed categories and redacted dashboard messages.
5. **Token preflight required**: Check balance before any metered onboarding, contract registration, matching, or settlement operation.
6. **Capability matrix required**: Validate required Host API capabilities at startup.
7. **No secret readback outside TEE**: Confirm secrets through contract health checks, not external reads.
8. **No active order persistence**: Supabase must never store active asset, side, quantity, bid, ask, queue rank, queue depth, or active counterparty.
9. **No sensitive logs**: TEE, backend, frontend, Playwright, and CI logs must be scanned for forbidden fields.
10. **Attestation references required**: Completed trade receipts must include T3 execution and attestation references before being treated as audit-ready.

## Questions to Resolve With Terminal 3 Before Implementation

1. Is programmatic agent delegation currently available for production or sandbox use, or is the T3N Dashboard the only supported setup path?
2. What package name and version should be used for ADK and any agent delegation/authority client APIs?
3. What exact APIs, if any, register an agent DID and bind delegated authority to contract/function/action scope?
4. How does authority revocation propagate to in-flight or queued TEE contract calls?
5. Is `did-registry` externally available, partner-only, or system-only today?
6. Which Host API capabilities are available to external developers in the sandbox today?
7. Are `readers` omitted on private maps default-deny or copied from `writers`?
8. What ADK API returns T3N token balance?
9. What operations are charged during tenant onboarding, map creation, contract registration, and contract execution?
10. What attestation evidence is returned by contract execution, and how should clients verify it?
11. Can TEE contract logs contain decrypted request parameters, and where are those logs retained?
12. How should contract versions be rolled back while preserving old receipt/audit references?
13. Are outbox and signing capabilities available for financial settlement workflows?
14. Is there an official TypeScript example for multi-tenant delegated agent authorization?
15. Is there a production status page or compatibility matrix for ADK, Host API, and T3N sandbox capabilities?

## Suggested Follow-Up Work Items

- Add `t3-enclave/src/capabilities/capability-matrix.ts` during implementation.
- Add `t3-enclave/src/errors/t3-error-map.ts` before any ADK call sites.
- Add `t3-enclave/src/keys/map-name.ts` with branded types for map tail vs canonical map name.
- Add integration tests for real sandbox token preflight and map ACL verification.
- Add a vendor-confirmation checklist before any production deployment milestone.
- Add CI checks to reject forbidden fields in logs, test data builders, screenshots, snapshots, and WebSocket events.

## Bottom Line

Terminal 3 ADK/T3N documentation gives enough confidence to design GhostBroker around T3 as a confidential execution layer, but not enough to directly implement fully automated production agent onboarding without further confirmation. The docs show dashboard-based AI agent delegation, while the contract-level `agent-auth` Host API interface and adjacent identity/permission capabilities are marked `Coming soon`. GhostBroker should proceed with a strict `t3-enclave/` adapter boundary, production startup capability checks, and no fake authority or local mock substitute.

---

### T3-ONB-007: Agent Delegation Credential Model Differs Between Published BUIDLs

**Severity**: P0
**Category**: Onboarding blocker / agent deployment
**Affected docs**: T3N DIDs, ADK overview, "Delegate Access to AI Agents"
**Date filed**: 2026-06-14 (updated 2026-06-14 after the first end-to-end agent run)

## What I found (Jun 2026, and again after the JCS → Ghostbroker delegation consolidation)

The public T3 documentation implies a dashboard-driven delegation flow
("enter an Agent DID, select a TEE contract, optionally select functions,
optionally configure allowed hosts"). There is **no T3 dashboard** in
practice. The only T3 onboarding surface a developer gets is the claim
page at `https://www.terminal3.io/claim-page`, which issues a single
`T3N_API_KEY`. Everything else (agent DID, delegation credential) is
derived from that key at runtime.

The GhostBroker agent stack (this repo, `agents/` workspace) was
built around the Ghostbroker delegation BUIDL (the only published live reference
for "what Terminal 3 actually gives you"). Ghostbroker delegation models the
delegation as a **W3C Verifiable Credential JSON-LD** with `issuer` /
`credentialSubject` / `proof.jws` fields, a budget, and a category
allowlist. The agent's identity is a derived `did:t3n:0x<eth-address>`
from a real `T3nClient.handshake()` + `client.authenticate()`
round-trip, and the only T3 secret needed is `T3N_API_KEY`. The
credential is signed locally and persisted to disk.

### Original (now-resolved) JCS path

The original GhostBroker verifier (in
`t3-enclave/src/auth/delegation-credential.ts`) was built against a
JCS-shaped T3 Smart VC constructed by the `@terminal3/t3n-sdk`
`buildDelegationCredential` helper, with `user_did` / `agent_pubkey` /
`vc_id` / `not_before_secs` fields, signed by an admin and an agent
secp256k1 key. That model required 5+ env vars (`CREDENTIAL_JCS_BASE64`,
`POLICY_HASH`, `ADMIN_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `AGENT_DID`)
and a manual keypair generation step that is not documented anywhere.
The JCS path is now **deleted** from GhostBroker — see the Jun 14
consolidation that left only the Ghostbroker delegation verifier in
`t3-enclave/src/auth/ghostbroker-delegation.ts`. The 5 JCS verifier
tests in `auth-delegation-credential.test.ts` and the
`DelegationProofBuilder` in the agent SDK are gone; the run-loop calls
`client.admitAgent({institutionId, agentDid, delegationCredential})`
with the Ghostbroker delegation VC loaded from disk.

### Why this matters for GhostBroker

The agents in this repo can run end-to-end against the live T3N
network using the **Ghostbroker delegation flow** with one T3 secret
(`T3N_API_KEY`). The run-loop admits the agent with the VC from
`setup:delegation`; the backend persists the VC on the agent record;
submit / cancel / settlement all re-verify the same VC against the
persisted `metadata.delegation_credential` field. No JCS prove, no
admin keypair ceremony, no dashboard integration.

## Impact

- A new agent developer can run a smoke test today with **one**
  T3 secret (`T3N_API_KEY`) instead of five.
- A bounty reviewer can verify the integration end-to-end by:
  1. `npm run setup:identity` — calls the live T3N network, writes
     a real `did:t3n:0x...` to disk.
  2. `npm run setup:delegation` — mints a W3C VC to disk.
  3. `npm run buyer` and `npm run seller` — submit, match, settle.
- The Ghostbroker delegation path is the only admit shape (`client.admitAgent` with
  `delegationCredential`); the JCS-prove path is gone from the SDK.
  `client.admitAgentWithDelegationCredential` is deleted.

## Recommended fix for docs

Add a single page titled **"Agent onboarding — what you actually get
from Terminal 3"** with:

- A clear statement: there is no T3 dashboard. The onboarding surface
  is the `T3N_API_KEY` from the claim page.
- A diagram of the Ghostbroker delegation flow: claim key → T3N handshake → DID →
  W3C VC → bound to DID → agent authenticates → submits intents.
- The wire format of the W3C VC (with a JSON example) and the single
  verifier mode (`live` — full `EcdsaSecp256k1Signature2019` JWS
  verification, fail-closed on any SDK exception; no `sandbox` /
  `structural` off-ramp).
- A note that the Smart VC / JCS-prove shape is a future
  programmatic-issuer mode; the Ghostbroker delegation shape is what works
  today.

## Recommended implementation action

- Keep the Ghostbroker delegation verifier in `t3-enclave` as the single
  per-action authority gate. The JCS-prove path is gone.
- The Ghostbroker delegation path is the smoke-test gate **and** the production
  gate. Tests for it should pass.
- A combined `setup:all` helper that mints a Ghostbroker-style
  delegation VC and a real agent DID in one step would be a
  one-line addition on top of `setup:identity` and
  `setup:delegation`.
- Keep `agents/README.md` as the de-facto onboarding doc until
  Terminal 3 publishes a canonical page.

## Verification

A new agent developer with the README and a fresh
`gbk_…` + `T3N_API_KEY` can:

1. `npm install` at the repo root.
2. `cp agents/.env.example agents/.env` and fill in the two keys.
3. `npm run setup:identity` — see a real `did:t3n:0x...` printed.
4. `npm run setup:delegation` — see a real VC written to disk.
5. `npm run buyer` and `npm run seller` in two terminals.
6. Observe: buyer + seller submit intents → match → settle →
   receipt available. **No T3 dashboard, no Smart VC issuer, no
   secret sprawl, no JCS prove.** The full smoke test takes ~5
   minutes once the two T3 keys are in `.env`.

Once the above is true, the on-the-page path from `git clone` to
a running two-agent smoke test against live T3 is complete.

---

## Addendum (2026-06-15) — T3N `matching` contract registration is required for live seal calls

**Discovered while debugging** `400 validation_failed: The request could not be accepted.`
on `POST /api/agents/intents` during the seller-agent loop in GhostBroker.

### Symptom

The agent authenticates, admits, and submits an encrypted intent. The
orchestrator route calls
`T3BlindIntentClient.sealIntent(...)` (in
`t3-enclave/src/matching/blind-intent.ts`), which `POST`s to
`/contracts/matching/blind-intents` on the T3N testnet. T3N replies:

```
HTTP 404
{
  "code": "not_found",
  "detail": "tenant contract <tenant_did>:matching not registered",
  "request_id": "..."
}
```

The T3 SDK wraps the 404 as a `503` with body
`{ "code": "t3_sdk_request_failed", "message": "HTTP 404: Method not found (...)" }`.
The `T3BlindIntentClient` previously threw the generic
`Error("T3 hidden intent sealing failed.")` and the orchestrator route
swallowed it as `400 validation_failed: "The request could not be
accepted."` with no upstream detail, leaving the agent log uninformative.

### Root cause

The T3N tenant identified by `T3_TENANT_DID`
(`did:t3n:a07f5f528c01e22dfd229a027c4b4afa4514e952` in our dev `.env`)
has **no `matching` smart contract registered** on the testnet. The
seal call needs the contract to exist on the tenant's account before
the testnet will accept the call.

### What the docs do not cover

The ADK / T3N docs describe tenant onboarding (`tenant.tenant.claim()`,
`tenant.tenant.me()`) and tenant KV-map provisioning
(`/tenant/maps`), and TEE contract publishing, but do **not** document:

- A first-class SDK call to publish a TEE smart contract
  (`matching`) and register it on a tenant. The T3N SDK exposes
  `tenant.contracts.execute(...)` for *calling* a contract, but the
  `register` / `publish` flow is undocumented.
- Whether the `matching` contract that GhostBroker needs is a
  built-in (provided by T3) or one that the GhostBroker team
  needs to publish themselves. The TEE contracts under
  `ghostbroker-delegation-reference/contracts/` are an
  existing reference (currently `procurement-policy`); the
  matching contract for the dark-pool pipeline has not been
  located in the workspace and may need to be authored and
  published.
- The error code shape we saw — `code: "not_found", detail:
  "tenant contract <did>:<contract> not registered"` — is
  produced by the T3N host but is not listed in the ADK common
  errors page.

### Production impact

This is the second silent-failure bug in the live seal path.
GhostBroker agents that get past VC verification (admit succeeds)
still 400 on the very first submit and the agent log shows a
generic `validation_failed: The request could not be accepted.`
with no signal that T3N rejected the seal. Operators had to
attach a debugger to the backend to find the cause.

### Fixes shipped in GhostBroker

1. New typed error in `t3-enclave`:
   `BlindIntentSealFailureError` with
   `kind: "contract_not_registered" | "t3_request_failed" | "t3_unreachable"`,
   `status`, and `upstreamBody`. The seal call classifies the
   T3N response and throws this typed error instead of a
   generic `Error("T3 hidden intent sealing failed.")`.
2. New `classifyBlindIntentSealFailure(status, body)` helper
   (exported for testability) that recognises both the bare T3N
   404 body and the SDK-wrapped 503 with `code:
   "t3_sdk_request_failed"`. Extracts the contract name from
   the T3N detail string when present, falls back to
   `"matching"` otherwise.
3. `POST /api/agents/intents` route maps the typed error to
   `503 sealing_failed` with the upstream cause on the response
   (`code: "sealing_failed", message: "...", cause: "T3N tenant
   contract 'matching' is not registered for this tenant. ..."`)
   so the agent log surfaces the real reason.
4. `PublicError.toResponse()` exposes a `cause: string` field
   for `sealing_failed` and `service_unavailable` codes only.
   Authorization and validation errors continue to omit
   `cause` to avoid leaking internal detail.
5. Tests: 7 new tests in
   `t3-enclave/src/tests/blinding.test.ts` (classification +
   the typed error path), 2 new tests in
   `backend/src/tests/contracts/agents-intents.contract.test.ts`
   (the 503 mapping + the 400-regression guard), 7 new tests
   in `backend/src/tests/unit/public-error.test.ts` (cause
   redaction rules).

### Operator action required (un-blocked by the fix above)

The user must register the GhostBroker `matching` TEE contract
on the T3N testnet tenant before the seller/buyer loops can
succeed. The fix above surfaces the *cause* clearly; the fix
does not by itself provision the contract on T3N. Possible
paths:

- Publish the matching TEE contract shipped in
  `ghostbroker-delegation-reference/contracts/` to the
  GhostBroker tenant via the T3N control-plane dashboard
  (recommended — this is the path the reference
  `ghostbroker-delegation-reference/src/scripts/publish-contract.ts`
  script follows).
- Wait for Terminal 3 to expose a `tenant.contracts.publish`
  SDK call and integrate it into the GhostBroker
  `setup:identity` / `setup:delegation` flow so the contract
  is auto-registered at agent-creation time.

### Severity

- **P1**: blocks every live submit on T3N, but the fix removes
  the silent-failure mode so operators can diagnose it from
  the agent log alone. The contract-registration step itself
  is a one-time T3N operation, not a recurring bug.

### Resolution (2026-06-15)

The full fix is now shipped and the orchestrator's 404 is gone.
Three new artifacts carry the fix:

- `contracts/matching-policy/` — a new Rust crate that compiles
  to a WASI Preview 2 core module exposing `seal-intent` and
  `evaluate-match`. Pure functions, deterministic SHA-256
  handle minting, 152 KB stripped WASM at v0.1.0 / 175 KB at
  v0.1.1 (the bump added the `generic-input` envelope
  unwrapper).
- `scripts/publish-matching.ts` — reads `backend/.env` for the
  T3N credentials, builds a T3nClient + TenantClient session,
  and calls `tenant.contracts.publish({ tail: "matching",
  version, wasm })`. Idempotent: re-publish at the same
  version is a no-op (the `already_registered` shape is
  treated as success). To push a new version, set
  `T3_MATCHING_CONTRACT_VERSION` (env wins over .env).
- `scripts/verify-matching-contract.ts` — calls `seal-intent`
  and `evaluate-match` against the live tenant and prints the
  opaque handles. Use this to confirm the registration took
  effect after a T3N reset.

### How to reproduce the fix from a clean checkout

```sh
# 1. Install the wasm32-wasip2 target (one-time).
rustup target add wasm32-wasip2

# 2. Build the contract.
cd contracts/matching-policy
cargo build --target wasm32-wasip2 --release
# WASM lands at target/wasm32-wasip2/release/matching_policy.wasm

# 3. Publish it. Uses T3N_API_KEY + T3_TENANT_DID from
#    backend/.env. Bump T3_MATCHING_CONTRACT_VERSION to
#    push a new version (T3N enforces monotonic versions).
cd ../../       # back to repo root
npx tsx scripts/publish-matching.ts
# Result: "✓ Published contract matching v0.1.X"

# 4. Verify it works.
npx tsx scripts/verify-matching-contract.ts
# Both calls return opaque handles → orchestrator's 404 is gone.

# 5. Restart the backend so the T3 client picks up the
#    new contract registration (in-memory cache).
cd backend && npm run dev
```

### What we now know about the T3 contract publish path

- T3N accepts a **core WASM module** (not just components) as
  the `wasm` field of `contracts.publish`. The
  `wasm32-wasip2` target + `cdylib` crate-type is sufficient;
  `wasm-tools` / `wasm-component-ld` are not required.
- T3N enforces **monotonic contract versions** per (tenant,
  tail). Re-publishing at the same version returns
  `bad_request: "contract version invalid: version X is not
  higher than current version X"`. The publish script bails
  with a non-zero exit; bump `T3_MATCHING_CONTRACT_VERSION`
  to push a new version.
- T3N dispatch wraps the body in a `generic-input` envelope
  whose `input` field is the JSON-stringified call body. The
  contract's first job is to unwrap that envelope before
  parsing the inner shape.
- The Rust toolchain `wasm32-wasip2` target was not in the
  default `rustup` install on this machine. The setup script
  in the new `contracts/README.md` documents the one-time
  `rustup target add wasm32-wasip2` step.

### T3-ONB-017: TEE Contract Inputs Are Strictly snake_case — the SDK Does Not Translate

**Severity**: P1
**Category**: TEE contract authoring / orchestrator↔contract contract
**Affected docs**: WIT world examples, generic-input envelope docs, the procurement-policy reference BUIDL

**What I found**

T3N host-dispatched contracts read their function input by JSON-parsing
the `input` field of the `generic-input` envelope. The Rust
`serde::Deserialize` derive defaults to field-name matching: a struct
field `institution_id: String` deserializes from JSON key
`"institution_id"`, not `"institutionId"`. There is no `#[serde(rename_all = "camelCase")]` in either of the GhostBroker matching contract
shapes (`SealIntentInput`, `EvaluateMatchInput`) nor in the
procurement-policy reference BUIDL — they all use the default snake_case
field names.

The GhostBroker public API surface (REST routes, agent-client SDK,
agents orchestrator, in-memory `BlindIntentRequest` / `MatchEvaluationRequest`
types) is camelCase, the way TypeScript codebases naturally model JSON.
The `T3BlindIntentClient` and `T3MatchContractClient` originally posted
their `request.body` directly to the network client — which meant the
contract received `{"institutionId": "...", "encryptedIntentEnvelope":
"..."}` and serde rejected it with
`seal-intent: invalid JSON input: missing field 'institution_id' at
line 1 column <N>`. The 400 from the host was then re-wrapped by
`classifyBlindIntentSealFailure` as a generic `t3_request_failed`,
which masked the schema mismatch and made the error look like an
upstream T3N problem.

**Why this matters for GhostBroker**

The matching contract is the load-bearing TEE primitive of the
dark-pool orchestrator. Every `POST /api/agents/intents` call from an
agent eventually flows through this envelope. If the camelCase form is
posted, the contract fails every call and no agent can submit an
intent. The error path is silent (the typed
`BlindIntentSealFailureError` correctly returns 503 with a cause, but
the cause points at the *contract-not-registered* remediation because
that was the only classified kind; the actual cause
`"missing field 'institution_id'"` was preserved on the
`upstreamBody` but the `message` field misled operators).

**Recommended fix for docs**

- Spell out in the WIT world docs: the contract's input struct uses
  whatever field names the Rust `Deserialize` derive produces, and
  there is no implicit camelCase translation. State explicitly that
  T3 host dispatch does **not** rewrite keys.
- The reference BUIDLs (`procurement-policy`, future TEE contract
  samples) should include a short note: "field names here match the
  Rust struct; client code must translate to snake_case before
  posting."
- Common Errors page should add a diagnostic for the
  `bad_request: "invalid JSON input: missing field '...'"` shape,
  pointing operators at the wire-format mismatch.

**Recommended implementation action**

- In `t3-enclave/src/matching/blind-intent.ts` and
  `t3-enclave/src/matching/match-contract-client.ts`, translate the
  public camelCase request type to a snake_case body just before
  `networkClient.request(...)` (commit: fix camelCase→snake_case TEE
  contract input translation). Keep the public TS interface camelCase
  to match the agent-client SDK and the REST surface; translate at
  the network boundary.
- Update the two on-the-wire body assertions in
  `src/tests/blinding.test.ts` and
  `src/tests/match-contract-client.test.ts` to assert snake_case.
- (Optional, future) Extend `classifyBlindIntentSealFailure` with a
  `body_validation` kind that detects
  `code: "bad_request"` + `detail` starting with
  `"<function-name>: invalid JSON input: missing field"` so future
  field-shape regressions return a typed error pointing at the
  field, not at "matching not registered". The current
  `t3_request_failed` fallback already surfaces the upstream
  `detail` in the 503 `cause`, but a dedicated kind would let the
  route distinguish "fix your TEE call site" from "T3N is down".

**Verification**

- `t3-enclave` tests: 65/65 pass (post-fix).
- `backend` tests: 122/122 pass (post-fix).
- Live `verify-matching-contract.ts` returns a valid
  `intent_handle` + `execution_ref` from `seal-intent` against the
  published matching contract.


### Addendum (2026-06-15) — Chain rail (WS2) hits T3-ONB-011 / T3-ONB-013 head-on

**Symptom**

WS2 of the settlement-rails workstream ships a real Sepolia
ERC-20 chain rail
(`backend/src/services/settlement-rails/chain-sepolia-rail.ts`).
The rail's design calls for the relayer key to live inside a
T3 tenant TEE so that the on-chain calldata is the TEE's
`encryptedTradeFieldsRef` and the chain observer never sees
the plaintext `quantity` / `executionPrice` / `counterparty`.
That requires a TEE contract that holds a per-tenant signing
key and a `sendTransaction`-equivalent egress primitive — the
exact capabilities the Host API marks `Coming soon` for
external developers in T3-ONB-011.

**What GhostBroker did for the v1 demo**

- The relayer key is held in the backend's env
  (`SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`).
  The rail's runtime uses `viem`'s `walletClient` to sign and
  broadcast. The relayer key is a backend secret, not a
  per-tenant TEE secret, and the rail's class-level comment
  calls this out as a one-file production swap.
- The on-chain calldata is a sha256 of the trade fields
  (v1 stub), so the chain observer still sees only the tx
  hash, the gas, the `to` address, and a 32-byte blob. The
  plaintext `quantity` / `executionPrice` does not reach a
  public RPC node.
- A doc-gap entry was added at T3-ONB-011 (this addendum)
  so the workaround and the production migration path are
  on the record.

**Production migration path (WS2.5)**

- Replace the backend-held relayer key with a T3 tenant TEE
  relayer contract. The relayer is a TEE contract with a
  per-tenant signing key; its `settle(bytes32,address,...)`
  ABI is the production equivalent of the v1 stub calldata.
- The rail's class is unchanged. Only the
  `walletClient` / `sendTransaction` plumbing swaps to
  `networkClient.request(...)` against the relayer contract.
- Egress is already authorized for the contract call
  (the matching contract's HTTP egress grant covers the
  relayer; see T3-ONB-012 for the grant-setup walkthrough).

**Severity**: P1 (this is the WS2 hackathon headline rail;
the production migration is unblocked but a real partnership
decision is required).

**Verification**

- `backend` tests: 141/141 pass (WS1 + WS2 + WS2.5; default
  suite 134/134, Anvil integration suite adds 7).
- `WS2_ANVIL_INTEGRATION=1` Anvil integration test
  (`src/tests/integration/settlement-rail-chain-sepolia.test.ts`):
  real broadcast, real tx hash, real receipt, on-chain
  `Settled` event decoded and asserted, two real ERC-20
  `Transfer` events on the asset and payment tokens, real
  on-chain `OutcomeAlreadySettled` revert on second settle.

### Addendum (2026-06-15) — WS2.5 ships the real on-chain relayer contract

**Status**: WS2.5 complete. The on-chain relayer
(`contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol`,
Solidity, Forge-compiled) is deployed per-institution by the
demo orchestrator. The backend's
`SepoliaErc20Rail` now uses `viem.writeContract` against the
relayer's `settle(bytes32, bytes32, address, address, address, address, uint256, uint256)`
ABI; per-institution deposit addresses are required (no more
degenerate `to=self` transaction). The Anvil integration
test deploys the relayer + 2 minimal ERC-20s + funds + approves
+ broadcasts + decodes the `Settled` event + asserts the
ERC-20 `Transfer` balances. 7/7 Anvil tests pass.

**Remaining gap (unchanged from the prior addendum)**: the
relayer key is still in the backend's env. The T3 tenant TEE
swap is a one-file change to `chain-sepolia-rail.ts` once
T3N exposes the relayer / signing / outbox host interfaces
(T3-ONB-011).

### Addendum (2026-06-15) — WS2.5.6 ships the TEE-attested relayer signer seam

**Status**: WS2.5.6 complete. The relayer's "key in env"
path is now wrapped behind a `RelayerTransactionSigner`
interface (`backend/src/services/settlement-rails/relayer-signer.ts`).
The v1 demo path is `ViemWalletRelayerSigner` (viem's
`WalletClient` with the env-var key). The production-swap
path is `TeeAttestedRelayerSigner` (the T3 tenant identity
loaded via `t3-enclave`'s `loadOrCreateTenantIdentity(...)`).

The `SepoliaErc20Rail`'s `dispatch` calls
`relayerSigner.signSettle(...)` and reads the on-chain `from`
from the result. The rail's `buildProof` now carries the
on-chain `from` in a new `railSignerAddress: string | null`
field on `RailSettlementProof` (null for the noop rail). The
relayer's contract is unchanged; the on-chain
`Settled(bytes32,bytes32,address,address,address,address,uint256,uint256)`
ABI is identical between the two signers. The privacy
claim is unchanged.

`app.ts` decides at boot time: when
`SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` is set (a T3
secret-ref), the wiring builds a `TeeAttestedRelayerSigner`
from the T3 tenant identity. When unset (the v1 demo), the
wiring builds a `ViemWalletRelayerSigner` from the
`SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY` env var.
The decision is a runtime `if` — no rebuild needed.

**The remaining gap (still T3-ONB-011)**: the underlying T3
secret-store + relayer-primitive host interface is still
`Coming soon` for external developers. The WS2.5.6 swap is
the production-swap interface; the swap from
`TeeAttestedRelayerSigner`'s file-backed tenant key (v1)
to a T3-tenant-TEE-held key (production) is a one-line
change to `app.ts` once the host interface ships. The
existing `loadOrCreateTenantIdentity(...)` call is the
canonical entry point; production's tenant-TEE key store
plugs in there.

**Verification**

- `backend` tests: 156/156 (default) + 163/163 (Anvil
  integration) — unchanged by WS2.5.6 because the
  interface is the same.
- `WS2_ANVIL_INTEGRATION=1` Anvil integration test
  (TEE-attested path) — the same 7 Anvil tests cover
  the TEE-attested signer; the proof now carries
  `railSignerAddress` whose value is the
  TEE-signer address (the tenant identity in v1
  demo, the TEE-held key in production).

