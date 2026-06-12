# Research: GhostBroker Institutional Dark Pool

## Terminal 3 ADK Integration

**Decision**: Use Terminal 3 ADK from a dedicated TypeScript `t3-enclave/` package and keep all ADK client, tenant, map, contract, and token operations out of the frontend and generic backend services.

**Rationale**: Terminal 3 documents ADK as a client SDK for agent tenant applications on T3N. It supports tenant onboarding, tenant-scoped data, TEE contract management, and TEE execution. The docs also state the current SDK supports TypeScript / JavaScript, which aligns with the requested Node.js stack.

**Alternatives considered**: Embedding ADK calls directly inside Express route handlers was rejected because it would mix confidential execution concerns with REST request handling and increase code drift.

**Sources**:

- https://docs.terminal3.io/developers/adk/overview/what-is-adk

## Terminal 3 Identity and Authority

**Decision**: Represent institutions and agents with T3 DIDs and isolate dashboard-provisioned agent delegation verification behind `t3-enclave/src/auth/agent-auth-client.ts`. Use a programmatic delegation SDK/API only if Terminal 3 exposes a real production surface.

**Rationale**: T3N documentation describes DIDs as universal identifiers for humans and agents, tied to authentication methods, permissions, data, and TEE contracts. The docs also describe dashboard-based AI agent delegation by Agent DID, authorized TEE contract, optional functions, and optional allowed hosts. Separately, the contract-level `agent-auth` Host API interface is listed as coming soon in current public docs, so an adapter boundary and fail-closed grant verification are required.

**Alternatives considered**: Building a project-specific authority system without Terminal 3 identity was rejected because it would bypass the explicit agent identity and authority requirement.

**Sources**:

- https://docs.terminal3.io/t3n/how-t3n-works/did
- https://docs.terminal3.io/t3n/data-owner-guide/delegate-access
- https://docs.terminal3.io/t3n/how-t3n-works/host-api

## Confidential Matching Boundary

**Decision**: Active hidden order parameters must be transformed into encrypted T3 execution payloads inside `t3-enclave/`; the backend stores only opaque handles and completed trade records.

**Rationale**: T3N TEE nodes provide hardware-backed confidential execution, end-to-end encrypted communication, attestation, and WASM sandbox execution. This matches the need to evaluate hidden buy and sell parameters without public or participant disclosure.

**Alternatives considered**: Matching in PostgreSQL or in the Express API was rejected because either approach would require raw active order parameters to exist in application storage or logs.

**Sources**:

- https://docs.terminal3.io/t3n/how-t3n-works/tees

## Tenant Private Maps and Secrets

**Decision**: Store T3 execution secrets and contract-only configuration in tenant private maps under explicit readers and writers.

**Rationale**: Terminal 3 docs require explicit readers for private maps and describe `z:<tid>:...` tenant prefixes. They also document seeding secrets into private maps through control-plane writes so the contract can read secrets at runtime without exposing them externally.

**Alternatives considered**: Storing secrets in Supabase was rejected because the database should store only metadata, completed history, and encrypted receipt payloads.

**Sources**:

- https://docs.terminal3.io/developers/adk/tips/create-kv-maps
- https://docs.terminal3.io/developers/adk/tips/seed-api-key

## T3 Token Sandbox

**Decision**: Add a preflight token balance check and bounded retry policy around contract registration and execution.

**Rationale**: T3N tokens meter TEE execution and storage. The docs distinguish normal failures, which can still consume execution fuel, from commit conflicts where charges are dropped with the failed transaction. GhostBroker must avoid uncontrolled retries for expensive matching and settlement attempts.

**Alternatives considered**: Retrying all T3 failures automatically was rejected because contract-level failures may be billable attempts.

**Sources**:

- https://docs.terminal3.io/t3n/how-t3n-works/tokens

## Deployment Split

**Decision**: Deploy the dashboard to Vercel and the Express/WebSocket API to Heroku, with Supabase as managed PostgreSQL.

**Rationale**: The requested deployment targets create a clean separation: static frontend delivery on Vercel, long-running WebSocket support on Heroku, and managed relational storage on Supabase. This also prevents frontend deployments from touching the T3 agent runtime.

**Alternatives considered**: A single full-stack deployment was rejected because it would couple frontend releases, WebSocket runtime behavior, and confidential agent dependencies.

## Dashboard Privacy

**Decision**: The dashboard displays only secure connection statuses, historical completed trades visible to the institution, and encrypted receipt metadata. It does not render active order queue state, active order counts, or queue emptiness.

**Rationale**: The feature spec requires masking the active hidden order queue, and privacy validation requires zero discoverable active order parameters.

**Alternatives considered**: Showing aggregate active-order counts was rejected because counts can leak liquidity and timing information.
