# Terminal 3 Docs Offline Reference

**Generated for**: GhostBroker  
**Generated on**: 2026-06-12  
**Source index**: https://docs.terminal3.io/llms.txt  
**Scope**: Consolidated, paraphrased reference for Terminal 3 ADK and T3N docs indexed at generation time.

## Important Use Note

This file is an offline working reference, not a verbatim mirror of Terminal 3 documentation. It summarizes the public docs so implementation can start from local context. Before production deployment, re-check official Terminal 3 docs for SDK version changes, API availability, security notes, and network behavior.

## Source URLs Crawled From the Docs Index

### ADK Prerequisites

- https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens.md
- https://docs.terminal3.io/developers/adk/get-started/prerequisites/set-up-dev-env.md

### ADK Walkthrough

- https://docs.terminal3.io/developers/adk/get-started/walkthrough/write-contract.md
- https://docs.terminal3.io/developers/adk/get-started/walkthrough/build-contract.md
- https://docs.terminal3.io/developers/adk/get-started/walkthrough/register-contract.md
- https://docs.terminal3.io/developers/adk/get-started/walkthrough/invoke-contract.md

### ADK Overview and Support

- https://docs.terminal3.io/developers/adk/overview/what-is-adk.md
- https://docs.terminal3.io/developers/adk/overview/why-adk.md
- https://docs.terminal3.io/developers/adk/support/t3-builder-tg.md

### ADK Tips

- https://docs.terminal3.io/developers/adk/tips/capabilities-from-wit-import.md
- https://docs.terminal3.io/developers/adk/tips/common-errors.md
- https://docs.terminal3.io/developers/adk/tips/create-kv-maps.md
- https://docs.terminal3.io/developers/adk/tips/outbound-http-auth-by-user.md
- https://docs.terminal3.io/developers/adk/tips/placeholders-outbound-calls.md
- https://docs.terminal3.io/developers/adk/tips/seed-api-key.md

### ADK Use Cases

- https://docs.terminal3.io/developers/adk/use-cases/payroll-agent.md

### Terminal 3 Intro

- https://docs.terminal3.io/intro/about-t3.md
- https://docs.terminal3.io/intro/platform.md
- https://docs.terminal3.io/intro/components/did.md
- https://docs.terminal3.io/intro/components/vc.md

### T3N Data Owner Guide

- https://docs.terminal3.io/t3n/data-owner-guide/delegate-access.md

### T3N Concepts

- https://docs.terminal3.io/t3n/how-t3n-works/architecture.md
- https://docs.terminal3.io/t3n/how-t3n-works/did.md
- https://docs.terminal3.io/t3n/how-t3n-works/host-api.md
- https://docs.terminal3.io/t3n/how-t3n-works/tees.md
- https://docs.terminal3.io/t3n/how-t3n-works/tokens.md
- https://docs.terminal3.io/t3n/how-t3n-works/z-namespace.md
- https://docs.terminal3.io/t3n/overview/what-is-t3n.md
- https://docs.terminal3.io/t3n/overview/why-t3n.md

### T3N Use Cases

- https://docs.terminal3.io/t3n/use-cases/delegate-access-to-agent.md
- https://docs.terminal3.io/t3n/use-cases/delegate-access-to-human.md
- https://docs.terminal3.io/t3n/use-cases/mpc.md
- https://docs.terminal3.io/t3n/use-cases/reusable-user-data.md

### API Specifications

- https://docs.terminal3.io/terminal-3-openapi.yml
- https://docs.terminal3.io/api-reference/openapi.json

## High-Level Model

Terminal 3 is a platform for privacy-preserving identity, verifiable data, and AI agent governance. T3N is the confidential compute network underneath it. The Agent Developer Kit, or ADK, is the developer SDK used to build agent tenant applications on T3N.

The design theme across the docs is:

- Give users, enterprises, and agents verifiable identities.
- Let data owners delegate narrow access rather than expose full credentials or private data.
- Execute sensitive logic inside TEE contracts.
- Keep private data in tenant-controlled namespaces.
- Use DIDs, verifiable credentials, delegated grants, and confidential execution to provide accountability.

For GhostBroker, the relevant mapping is:

- Institutions map to T3N tenants or data owners.
- Autonomous trading agents map to delegated AI agents.
- Hidden order evaluation maps to TEE contract execution.
- Sensitive trading constraints map to encrypted T3 inputs and private tenant data.
- Completed trade receipts map to encrypted outputs plus execution and attestation references.

## ADK Summary

### What ADK Provides

Source: https://docs.terminal3.io/developers/adk/overview/what-is-adk.md

ADK is a client SDK for building agent tenant applications on T3N. The current docs say the SDK supports TypeScript / JavaScript. It supports:

- Authenticated sessions using an Ethereum wallet.
- Encrypted channel setup to a TEE node.
- Tenant onboarding through tenant claim and lookup flows.
- Tenant-scoped data management through maps.
- TEE contract publishing and lifecycle operations.
- TEE contract execution.
- Cross-tenant calls to published contracts.

Implementation note for GhostBroker:

- Keep all ADK usage in `t3-enclave/`.
- Do not let frontend code import ADK directly.
- Backend should call `t3-enclave/` through typed services that return opaque handles and redacted state.

### Why ADK Exists

Source: https://docs.terminal3.io/developers/adk/overview/why-adk.md

The ADK is positioned around agent safety and privacy. The problem it solves is that agents often need to complete real-world tasks using sensitive data, but should not receive that data directly. ADK and T3N allow sensitive data to be stored and processed in controlled environments, while agents receive only allowed outputs.

GhostBroker interpretation:

- Trading agents should never receive raw settlement secrets or other institutions' order parameters.
- Agent action should be bounded by explicit authorization.
- Execution output should be sanitized before it reaches the agent or UI.

## ADK Onboarding Flow

### Request Test Tokens

Source: https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens.md

The docs index describes this page as a one-step flow to claim an account, key, and test tokens. Tokens matter because T3N meters execution and storage. For implementation, this means sandbox setup is not just credentials; it also requires enough token balance for map creation, contract registration, and execution.

GhostBroker actions:

- Add a startup check for token balance.
- Fail onboarding clearly when balance is missing or below threshold.
- Do not retry metered contract failures indefinitely.

### Set Up Development Environment

Source: https://docs.terminal3.io/developers/adk/get-started/prerequisites/set-up-dev-env.md

This page walks developers through local ADK setup. The broader walkthrough assumes a TypeScript/JavaScript client environment and Rust/WASM contract build chain.

GhostBroker actions:

- Node.js/TypeScript setup belongs in `t3-enclave/`.
- Rust/WASM contract build tooling belongs either in `t3-enclave/contracts/` or a separate `contracts/` package if the project grows.
- Environment variables should be explicit and validated at startup.

## TEE Contract Walkthrough

### 1. Write a TEE Contract

Source: https://docs.terminal3.io/developers/adk/get-started/walkthrough/write-contract.md

The docs show a Rust contract compiled as a WASM component. Core pieces include:

- `world.wit` to declare exported contract functions and imported host interfaces.
- `Cargo.toml` configured to emit a WASM component.
- Rust code generated from WIT bindings.
- Business logic split into contract functions.
- Examples involving synchronous HTTP and placeholder-based HTTP for private profile data.
- Secret reads from a private `secrets` KV map.

Key rule:

- Capabilities come from WIT imports. If a contract imports a host interface, that changes what the contract can ask the host to do.

GhostBroker actions:

- Create a minimal WIT world for matching and settlement.
- Avoid importing outbound HTTP unless absolutely needed.
- Add CI that inspects WIT imports for unexpected host capabilities.
- Keep matching logic unit-testable outside WASM where possible.

### 2. Build a TEE Contract

Source: https://docs.terminal3.io/developers/adk/get-started/walkthrough/build-contract.md

The build flow compiles the Rust contract to a WASM component. The docs recommend verifying the component interface after build.

GhostBroker actions:

- Add build scripts for release WASM.
- Add a verification step that checks exported function names and imported host interfaces.
- Fail CI if the compiled contract imports unexpected capabilities.

### 3. Register a TEE Contract

Source: https://docs.terminal3.io/developers/adk/get-started/walkthrough/register-contract.md

Registration uses a contract tail/name and a version. T3N stores the WASM artifact, allocates a numeric contract id, and records it under the tenant registry.

Documented troubleshooting themes:

- WASM path must exist.
- Tenant DID must come from the authenticated session, not be guessed.
- Contract versions must increase when re-registering.

GhostBroker actions:

- Store expected contract tail, version, and returned contract id.
- Never construct tenant DID by string manipulation.
- Read DID from authenticated session or tenant lookup.
- Treat version bumping as a controlled deployment step.
- Never unregister a contract version referenced by completed receipts.

### 4. Invoke a TEE Contract

Source: https://docs.terminal3.io/developers/adk/get-started/walkthrough/invoke-contract.md

Invocation requires authorization for required egress if the contract calls external hosts. The docs tie outbound authorization to user or agent grants.

GhostBroker actions:

- For MVP, prefer returning opaque settlement commands to backend rather than having contracts call external settlement rails directly.
- If outbound HTTP is needed, configure allowed hosts through delegation grants and test denied-host behavior.
- Emit only redacted execution state to backend and UI.

## Tenant KV Maps

### Create Tenant KV Maps

Source: https://docs.terminal3.io/developers/adk/tips/create-kv-maps.md

Tenant maps live under the tenant-owned namespace. The SDK uses tenant-local tails like `secrets`, while canonical names include the tenant prefix. Private maps need deliberate reader and writer settings.

GhostBroker actions:

- Use branded types in code:
  - `TenantMapTail`
  - `CanonicalTenantMapName`
- Do not pass raw strings between map APIs.
- Always set readers and writers explicitly.
- Verify ACLs after create/update.

### Storage Namespaces

Source: https://docs.terminal3.io/t3n/how-t3n-works/z-namespace.md

T3N distinguishes tenant-owned `z:` namespaces from system-owned namespaces. Tenant-owned canonical names follow this shape:

```text
z:<tenant-id-suffix>:<tail>
```

The docs say:

- Tenants create maps and TEE contracts at runtime.
- Writers control which tenant contracts may write.
- Readers control which tenant contracts may read.
- Cross-tenant access is denied unless explicitly granted.
- Public tenant data should go under a public tenant map convention.
- PII should not go into public maps.

Important caution:

- One page says omitted readers default from writers, while the KV map quick tip emphasizes setting readers explicitly to avoid read failures. Treat this as a documentation ambiguity and always set ACLs explicitly.

GhostBroker actions:

- Private maps:
  - `secrets`
  - `authority-claims`
  - `match-config`
  - `settlement-config`
- Public maps:
  - avoid for active trading data.
- Cross-tenant maps:
  - avoid unless a specific contract-to-contract access model is confirmed.

### Seed API Key Into Secrets Map

Source: https://docs.terminal3.io/developers/adk/tips/seed-api-key.md

The docs show seeding a secret through a control-plane write into a private map. At runtime, contract code reads the secret inside the enclave through KV access.

Important behavior:

- Control-plane secret writes may bypass normal map writers ACL.
- Runtime reads still depend on map reader authorization.
- Secrets are meant to be consumed inside TEE execution, not read back by app code.

GhostBroker actions:

- Do not log secrets.
- Do not read secrets outside TEE.
- Store only key version and references in Supabase.
- Verify secret availability through a contract health check.

## Capabilities and Host API

### Capabilities From WIT Imports

Source: https://docs.terminal3.io/developers/adk/tips/capabilities-from-wit-import.md

Contract capabilities are derived from imported host interfaces in `world.wit`. There is no separate manifest to review. This means code review must include the WIT file and compiled WASM component imports.

GhostBroker actions:

- Add a capability review step before registering contracts.
- Fail CI when unexpected imports appear.
- Keep matching and settlement contracts on the smallest capability surface possible.

### Host API

Source: https://docs.terminal3.io/t3n/how-t3n-works/host-api.md

TEE contracts run as WASM components inside a sandboxed runtime. By default, they do not get direct OS, network, filesystem, clock, randomness, or system access. They interact through typed host interfaces.

Host interfaces described in the docs:

| Interface | Status / Notes | GhostBroker relevance |
| --- | --- | --- |
| `kv-store` | Available for contract namespaced KV reads/writes/deletes | Needed for private contract state |
| `tenant` | Available for tenant lifecycle and metadata reads | Useful for tenant-aware contracts |
| `logging` | Available diagnostics capability | Must be tightly redacted |
| `http` | Outbound HTTP with egress allowlist | Avoid unless required |
| `http-with-placeholders` | Host substitutes authorized profile fields into outbound HTTP | Likely not needed for dark pool MVP |
| `signing` | Marked coming soon for z-namespace in reviewed docs | Do not assume available for settlement signing |
| `outbox` | Marked coming soon | Do not rely on contract-side deferred side effects |
| `vp` | Marked coming soon | Not required for MVP |
| `did-registry` | Marked coming soon | Confirm before programmatic DID changes |
| `agent-auth` | Marked coming soon as a Host API interface | Dashboard delegation exists, programmatic host interface needs confirmation |
| `user-profile` | Marked coming soon | Not core for GhostBroker |
| `user-removal` | Marked coming soon | Not core for MVP |
| `contracts-call` | System-only | Do not assume app contracts can use it |
| `stash` | System-only | Not needed for MVP |
| `agent-registry` | System-only | Do not assume available |
| `authorisation` | System-only | Do not assume contract-side preflight access |
| `otp` | System-only | Not relevant to MVP |
| `config/read` | System-only | Do not rely on it |
| `provider-config` | System-only | Do not rely on it |
| `time` / `clock` | System-only in table | Avoid contract time assumptions unless confirmed |
| `node-config` | System-only | Do not rely on it |

GhostBroker actions:

- Maintain a Terminal 3 capability matrix.
- Fail production startup if required capabilities are unavailable.
- Do not assume signing, outbox, did-registry, or agent-auth Host API can be used by app contracts.
- Use dashboard delegation unless Terminal 3 confirms programmatic delegation APIs.

## Outbound HTTP

### User Authorization Controls Egress

Source: https://docs.terminal3.io/developers/adk/tips/outbound-http-auth-by-user.md

Outbound HTTP is controlled by user or agent grants, not merely by contract code. The docs distinguish:

- Delegated call: uses the subject user's grant.
- Direct call: uses the caller's own grant.

GhostBroker actions:

- Treat allowed hosts as part of delegated authority.
- Do not encode allowed hosts only in app config.
- Test denied-host behavior.

### Placeholders In Outbound Calls

Source: https://docs.terminal3.io/developers/adk/tips/placeholders-outbound-calls.md

The `http-with-placeholders` model lets the host substitute authorized user profile markers into outbound requests without exposing plaintext to the WASM contract. It is synchronous and shares the egress allowlist model with regular HTTP.

GhostBroker actions:

- Not required for hidden order matching.
- Could be useful in a future integration where profile data or settlement identity fields must be passed to a third party without entering contract memory.

## Common Errors

Source: https://docs.terminal3.io/developers/adk/tips/common-errors.md

The docs say errors return as JSON-RPC `bad_request` with a detail string, and the SDK throws the human-readable detail rather than a typed object. Some auth errors include a machine-readable prefix.

Important error categories:

- Contract version is not higher than current version.
- Map already exists.
- Map not found.
- Canonical map name invalid.
- Quota exceeded.
- Access denied to map operation.
- Tenant suspended.
- HTTP egress denied because host is not in authorization grant.
- Wallet/authentication errors such as authenticator limit, auth map conflict, email not verified, user not found, and legacy field.

GhostBroker actions:

- Centralize Terminal 3 error mapping.
- Do not pass raw Terminal 3 detail strings to UI.
- Map errors into safe internal categories:
  - `authority_denied`
  - `map_acl_denied`
  - `token_metering_failed`
  - `contract_version_conflict`
  - `contract_execution_failed`
  - `tenant_suspended`
  - `network_unavailable`
- Use substring matching only inside a small adapter until typed SDK errors exist.

## T3N Core Concepts

### What Is T3N

Source: https://docs.terminal3.io/t3n/overview/what-is-t3n.md

T3N is a decentralized confidential computing network. It supports use cases such as:

- Delegating access to AI agents.
- Delegating access to human helpers.
- Confidential multi-party computation.
- Reusable verified user data.

Actors described in the docs include:

- Developers.
- Data owners.
- Data providers.
- Data consumers.
- Node operators.
- Compliance authorities.
- VC issuers.
- VC verifiers.

GhostBroker mapping:

- Institutions are data owners and data consumers.
- Trading agents are AI agents delegated by institutions.
- The dark pool matching contract is a confidential computation.
- Regulators or auditors may map to compliance authorities in later phases.

### Why T3N

Source: https://docs.terminal3.io/t3n/overview/why-t3n.md

T3N addresses privacy risks, accountability gaps, and trust problems around AI agents and digital identity. It is positioned for scenarios where private data must be used without being handed directly to agents or applications.

GhostBroker mapping:

- The platform should let institutions trade without revealing active order details.
- Agents should be accountable through identity and delegated permissions.
- Confidential execution should make matching verifiable without exposing inputs.

### Architecture

Source: https://docs.terminal3.io/t3n/how-t3n-works/architecture.md

The architecture docs mention:

- Client SDKs.
- MCP.
- APIs.
- Webhooks.
- TEE clusters.
- Regional storage.
- Content-addressable storage.
- Regulatory vault.

GhostBroker actions:

- Use ADK client SDK from `t3-enclave/`.
- Keep API/WebSocket logic in backend separate from T3N confidential execution.
- Store only post-trade encrypted records in Supabase.

### DIDs

Sources:

- https://docs.terminal3.io/intro/components/did.md
- https://docs.terminal3.io/t3n/how-t3n-works/did.md

DIDs are permanent network identifiers linked to authentication methods, permissions, data, and TEE contracts. T3N DIDs use the T3N method and can represent humans or agents. Each DID can hold a token balance.

Important details:

- DIDs are tied to one user profile or agent.
- DIDs are used to manage data and TEE contracts.
- DID documents contain information needed to resolve and authenticate DID subjects.

GhostBroker actions:

- Use separate identities for institution tenant, operators, and agents.
- Do not assume agent DID and institution DID are interchangeable.
- Store the institution tenant DID in `institutions.t3_tenant_did`.
- Store agent DID references in agent records when implemented.

### Smart Verifiable Credentials

Source: https://docs.terminal3.io/intro/components/vc.md

VCs represent claims issued by trusted issuers about credential subjects. Holders can present credentials to verifiers. The docs describe the triangle of trust:

- Issuer.
- Holder or subject.
- Verifier.
- Verifiable data registry.

VCs can be revoked by issuers and deleted by holders.

GhostBroker actions:

- VCs are not required for the MVP unless institutions need reusable KYC/AML or accredited investor credentials.
- Future compliance workflows could use VCs for institutional eligibility.

### TEE Nodes

Source: https://docs.terminal3.io/t3n/how-t3n-works/tees.md

TEE nodes provide confidential and verifiable computation. The docs describe:

- Encrypted communication channels.
- Authentication and attestation services.
- Consensus-backed storage.
- Merkle-tree integrity proofs.
- Host functions.
- WASM contract execution inside TEEs.

GhostBroker actions:

- Keep hidden matching in TEE execution.
- Store `t3_execution_ref` and `t3_attestation_ref` on completed receipts.
- Add verification around attestation references before treating receipts as audit-ready.

### Tokens

Source: https://docs.terminal3.io/t3n/how-t3n-works/tokens.md

T3N tokens meter execution and storage. Tokens can be associated with DIDs. The docs discuss failure semantics, including that some failures may still consume execution fuel while certain commit conflicts may not be charged.

GhostBroker actions:

- Check token balance before metered operations.
- Use bounded retries.
- Treat token exhaustion as a redacted operational failure.
- Avoid retry loops around potentially billable failures.

## Delegation

### Data Owner Delegation Guide

Source: https://docs.terminal3.io/t3n/data-owner-guide/delegate-access.md

The docs describe dashboard-based delegation. A data owner can delegate access to:

- AI agents.
- Human users.
- Third-party services.

For AI agents, the dashboard flow is:

- Open the T3N Dashboard.
- Go to AI Agents.
- Add a new agent.
- Enter the Agent DID.
- Select an authorized TEE contract.
- Optionally select authorized functions.
- Optionally input allowed hosts.
- Add the grant.

Revocation is also dashboard-based:

- Open AI Agents.
- Find the agent.
- Remove it.

Important behavior:

- If optional functions and hosts are not specified, the grant may be broad. For GhostBroker, do not leave these broad.

GhostBroker actions:

- Require narrow contract/function/host grants.
- Document manual dashboard setup if no programmatic delegation API is available.
- Verify revocation before allowing new intent submission.

### Delegate Access to AI Agents Use Case

Source: https://docs.terminal3.io/t3n/use-cases/delegate-access-to-agent.md

The docs describe AI agents acting on behalf of users or enterprises while sensitive data stays in T3N. Enterprise examples include B2B procurement and payroll. The key pattern is:

- Data owner stores sensitive data in T3N.
- Data owner authorizes an agent with policy constraints.
- Agent performs non-sensitive parts of workflow.
- For sensitive execution, agent submits an instruction to T3N.
- T3N uses protected data and returns sanitized results.

GhostBroker mapping:

- Institution stores sensitive settlement or authorization material in T3N.
- Institution authorizes trading agent with constraints.
- Agent submits encrypted trading intent.
- T3N evaluates match and settlement logic without exposing inputs.
- Backend stores only completed encrypted results.

### Delegate Access to Human Helpers

Source: https://docs.terminal3.io/t3n/use-cases/delegate-access-to-human.md

The docs describe restricted and temporary human access to private data for specific tasks, with revocation based on authorization rules.

GhostBroker mapping:

- Future operator workflows could use time-limited access grants.
- Not needed for MVP unless human operators need delegated data access in T3N.

### Confidential Multi-Party Computation

Source: https://docs.terminal3.io/t3n/use-cases/mpc.md

The docs describe multiple data owners authorizing a TEE contract to compute over combined private data without revealing raw inputs to each other.

Example domains include fraud detection, medical research, supply chain optimization, privacy-preserving advertising, and market analysis.

GhostBroker mapping:

- Dark pool matching is closest to the confidential multi-party computation pattern.
- Buyers and sellers provide private parameters.
- TEE contract computes compatibility.
- Only authorized outputs are revealed.

### Reusable Verified User Data

Source: https://docs.terminal3.io/t3n/use-cases/reusable-user-data.md

The docs describe storing reusable private data and presenting verified credentials instead of repeatedly uploading raw documents.

GhostBroker mapping:

- Future institutional onboarding could use reusable verified credentials for KYC/AML, accredited investor status, broker-dealer status, or counterparty eligibility.

## Terminal 3 Platform Intro

### About

Source: https://docs.terminal3.io/intro/about-t3.md

Terminal 3 positions itself around privacy-preserving identity, data, and AI agent infrastructure.

### Platform Overview

Source: https://docs.terminal3.io/intro/platform.md

The platform includes:

- T3 Network.
- T3 Identity.
- T3 Verify.
- T3 Agent Developer Kit.
- T3 Agent Command, marked coming soon in the platform overview.

Themes:

- Portable identity.
- PII minimization.
- Smart VCs.
- Agent runtime policy enforcement.
- Tamper-proof audit trail.
- Cryptographically verifiable DIDs for agents.
- Sensitive data remains in T3N and does not enter agent memory or prompt history.

GhostBroker mapping:

- Use DIDs to identify trading agents and institutions.
- Use T3N as the privacy boundary for sensitive trading constraints.
- Use audit trails for settlement evidence.

## OpenAPI Specs

Sources:

- https://docs.terminal3.io/terminal-3-openapi.yml
- https://docs.terminal3.io/api-reference/openapi.json

The docs index exposes OpenAPI spec URLs. These should be fetched directly when implementing live SDK/API integration, because generated API schemas may change more often than narrative docs.

GhostBroker actions:

- Do not hand-code assumptions from old OpenAPI content.
- Add a task to inspect OpenAPI specs before implementing direct REST calls.
- Version-pin any generated clients.

## Practical GhostBroker Integration Guide

### Recommended Repository Boundary

Keep this layout:

```text
t3-enclave/
|-- src/
|   |-- auth/
|   |-- keys/
|   |-- matching/
|   |-- runner/
|   `-- sandbox/
```

Responsibilities:

- ADK session creation.
- Tenant DID claim and lookup.
- Agent delegation checks.
- T3 token balance checks.
- Private map provisioning.
- Secret seeding.
- TEE contract registration.
- TEE contract invocation.
- Contract error normalization.
- Opaque result mapping.

Do not put these concerns in:

- `frontend/`
- generic Express route handlers
- Supabase migrations
- dashboard hooks

### Production Startup Checks

At backend startup or T3 enclave initialization, verify:

- Required environment variables are present.
- ADK client can open an authenticated session.
- Tenant DID resolves.
- T3 token balance is above threshold.
- Required private maps exist with expected ACLs.
- Expected TEE contract tail/version is registered and enabled.
- Required delegation grants exist for test agent or institution agent.
- Capability matrix matches the contract's expected WIT imports.

### Private Map Policy

Suggested maps:

| Map tail | Purpose | Readers | Writers |
| --- | --- | --- | --- |
| `secrets` | Settlement/provider secrets and receipt key references | matching/settlement contract only | control-plane seed only or approved contract |
| `authority-claims` | Delegated authority claim material | authority/matching contract | onboarding contract or control-plane |
| `match-config` | Matching rules and thresholds | matching contract | admin/control-plane |
| `settlement-config` | Settlement policy and rails metadata | settlement contract | admin/control-plane |

Do not store active order plaintext in Supabase or public maps.

### Contract Capability Policy

Default stance:

- Matching contract should import only what it needs.
- Avoid `http` and `http-with-placeholders` unless external calls are required.
- Avoid reliance on Host API entries marked coming soon or system-only.
- Treat `logging` as sensitive because contract logs can accidentally leak data.

### Error Mapping Policy

Normalize Terminal 3 errors inside `t3-enclave/`. The rest of GhostBroker should see only internal categories.

Suggested categories:

```text
authority_denied
map_acl_denied
map_not_found
token_metering_failed
contract_version_conflict
contract_execution_failed
tenant_suspended
egress_denied
quota_exceeded
network_unavailable
unknown_t3_failure
```

### Telemetry Policy

Allowed WebSocket state labels:

```text
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

Forbidden payload fields:

```text
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

### Agent Delegation Policy

Current docs show dashboard-based delegation for AI agents. The Host API lists `agent-auth` as a coming-soon host interface. Until Terminal 3 confirms a programmatic SDK/API, GhostBroker should:

- Document manual T3N Dashboard delegation setup for production.
- Require Agent DID, authorized TEE contract, authorized functions, and allowed hosts to be explicitly configured.
- Treat broad function or host grants as invalid for GhostBroker production.
- Add startup verification that confirms expected delegation exists.
- Fail closed if delegation cannot be verified.

## Documentation Gaps and Cautions

These are the important gaps found while building this local reference.

### Programmatic Agent Delegation

Dashboard delegation is documented. Programmatic agent delegation is not clearly documented in the reviewed ADK pages. The Host API `agent-auth` interface is marked coming soon.

Action:

- Confirm with Terminal 3 whether SDK/API-driven agent delegation is available.

### Map ACL Defaults

The storage namespace docs discuss reader defaults, while KV map tips emphasize setting readers explicitly. To avoid ambiguity:

- Always set readers and writers.
- Verify ACLs after provisioning.

### Typed Error Handling

Common errors use human-readable detail strings. This is brittle.

Action:

- Centralize substring matching in one adapter.
- Never leak raw details to the UI.

### Token Metering

Tokens meter execution and storage. Some failures may be billable.

Action:

- Preflight balance.
- Use bounded retries.
- Avoid repeated failed contract calls.

### Attestation Verification

TEE docs describe attestation conceptually, but the reviewed ADK pages do not provide a full TypeScript verification workflow.

Action:

- Store attestation references.
- Ask Terminal 3 for a verification workflow before claiming audit-grade settlement proof.

### Contract Lifecycle

Docs mention register, enable, disable, unregister, and version errors. A full release/rollback playbook is not obvious.

Action:

- Treat contract versioning as production release management.
- Do not unregister old contracts referenced by receipts.

## Terminal 3 Questions Before GhostBroker Production

1. Is programmatic AI agent delegation available, or is T3N Dashboard setup required?
2. What exact ADK package name and version should GhostBroker pin?
3. Are there separate SDK packages for agent delegation or authority verification?
4. How can code verify that an Agent DID is authorized for a contract/function/host grant?
5. How quickly does revocation propagate to contract invocation authorization?
6. What API returns token balance for a DID?
7. Which operations are billable if they fail?
8. Can app contracts use `time` or `clock`, or is that system-only?
9. Can app contracts use `signing` or `outbox`, or are they still unavailable?
10. What is the recommended production process for contract version rollback?
11. What attestation evidence does ADK expose to TypeScript clients?
12. Where are TEE logs retained, and who can read them?
13. Is there a way to inspect existing private map ACLs?
14. Is there an enterprise example for multi-tenant delegated agent workflows?
15. Is there a stable capability availability matrix by network or environment?

## Page-by-Page Quick Index

| Page | Local takeaway |
| --- | --- |
| Request Test Tokens | Needed before running sandbox operations; tokens meter execution/storage |
| Set Up Development Environment | Use TypeScript/JavaScript ADK client and Rust/WASM contract toolchain |
| Write Contract | Contract shape uses WIT, Rust, generated bindings, host imports, and private KV reads |
| Build Contract | Compile release WASM component and verify interface |
| Register Contract | Register by tenant, tail, and version; version must increase |
| Invoke Contract | Invoke contract after egress/delegation grants are configured |
| What Is ADK | ADK manages tenant onboarding, maps, contracts, and execution |
| Why ADK | Agents can act without receiving raw sensitive data |
| Create KV Maps | Create tenant maps with explicit access policy |
| Seed API Key | Seed secrets by control-plane write; read inside TEE |
| Capabilities From WIT | Host imports define contract capability surface |
| Outbound HTTP Auth | Egress depends on caller/delegation grant |
| Placeholders | Host substitutes authorized profile fields into outbound requests |
| Common Errors | SDK errors are human-readable strings; normalize locally |
| Host API | Defines available, coming-soon, and system-only host interfaces |
| Delegate Access | Dashboard flow for adding/removing agent grants |
| Architecture | T3N includes SDKs, APIs, TEE clusters, storage, CAS, vault concepts |
| DID | DIDs identify humans/agents and hold permissions/token balances |
| TEE Node | Confidential WASM execution with encrypted channels and attestation services |
| Tokens | Execution/storage metering and failure semantics |
| Storage Namespaces | Tenant resources live under `z:` namespace |
| Delegate Access to AI Agents | Enterprise and individual agent delegation patterns |
| Delegate Access to Human Helpers | Restricted temporary access for human helpers |
| MPC | TEE contracts can compute over private multi-party data |
| Reusable User Data | Verified credentials reduce repeated raw-document sharing |
| Platform Overview | T3 products cover identity, verify, ADK, and agent governance |
| Smart VCs | VC/VP model with issuer, holder, verifier, and registry |
| Payroll Agent | ADK use case for payroll-style sensitive execution |

## Refresh Procedure

When you want to refresh this file:

1. Fetch `https://docs.terminal3.io/llms.txt`.
2. Extract every `https://docs.terminal3.io/...` link.
3. Re-read changed `.md` docs and OpenAPI specs.
4. Update this file with changed SDK names, API availability, error behavior, and contract lifecycle rules.
5. Re-check the GhostBroker reports and tasks for stale assumptions.

PowerShell discovery command:

```powershell
$llms = (Invoke-WebRequest -Uri 'https://docs.terminal3.io/llms.txt' -UseBasicParsing).Content
[regex]::Matches($llms, 'https://docs\.terminal3\.io/[^)\s]+') |
  ForEach-Object { $_.Value } |
  Sort-Object -Unique
```

