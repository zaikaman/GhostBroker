# Changelog

All notable changes to `@ghostbroker/agent-client` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `LICENSE` (MIT), `SECURITY.md`, `CHANGELOG.md`, `.env.example`, `.npmrc.example`, `.gitignore`.
- `README.md` with installation, quickstart, full API reference, error-handling patterns, and configuration reference.
- Unit test suite for the public surface (`vitest`).
- `PortfolioClient` — agent-side read access to the institution's
  portfolio, exposed as `client.getAgentPortfolio({institutionId,
  agentDid})` and as the standalone `client.portfolio.getPortfolio(...)`
  method. Returns `{institutionId, agentDid, holdings, pendingReservations}`
  via `GET /api/portfolios/:institutionId?agentDid=...`. Use
  `holding.balance - holding.locked` to size the LLM's intent; the
  orchestrator's balance-lock check at submit time is the real
  authority.

### Removed
- `DelegationProofBuilder` and the JCS-prove admit path. The Ghostbroker delegation
  W3C VC is the only credential the live T3N onboarding surface mints;
  `client.admitAgent({institutionId, agentDid, delegationCredential})`
  is the only admit shape. The `examples/buyer-agent.ts` /
  `examples/seller-agent.ts` JCS-prove walkthroughs are gone — the
  `agents/` workspace is the canonical end-to-end smoke test.

## [0.2.0] - 2026-06-14

### Changed
- **API key authentication is now the only supported agent flow.** `AuthClient.authenticateWithApiKey(apiKey)` is the sole public auth method. The old `requestChallenge` / `verifyChallenge` / `authenticate(did, signer)` methods have been removed; the `AuthChallenge` and `AuthVerifyRequest` types have been removed from the public surface. The backend DID challenge routes remain available for the dashboard's operator login — agents should not call them.
- `GhostBrokerClientConfig` now accepts an optional `institutionId` so the telemetry WebSocket can be filtered correctly when a pre-existing session token is supplied at construction time. The `authenticateWithApiKey()` method also wires the institution ID automatically.
- `TelemetryClient.institutionId` is now mutable and exposed via `setInstitutionId(id)`. The previous `Object.assign(this, { telemetry: ... })` mutation in `GhostBrokerClient.authenticate()` is gone.
- All examples (`agent-buyer.ts`, `agent-seller.ts`) updated to use the API-key flow.

### Fixed
- The `Object.assign(this, { telemetry: ... })` hack in `GhostBrokerClient.authenticate()` is removed. The telemetry client is now updated in place via `setInstitutionId()`, so event handlers registered on `client.telemetry` survive authentication.
- `AuthenticateStep` and `WriteAgentStep` copy in the dashboard's `AgentDeploymentGuide` updated to accurately describe the key → session exchange and the 8-hour session lifecycle.

### Added
- `POST /api/auth/api-key` — new backend endpoint that exchanges a `gbk_…` key for a standard `AuthSession`. Validated by the existing `ApiKeyManagementService`; issues a session with `did: "apikey:<id>"`. Covered by `tests/contracts/auth-api-key.contract.test.ts`.
- `findById(id)` on `InstitutionRepository` so the new auth flow can resolve an institution from an API key without a tenant-DID lookup.

## [0.1.0] - 2026-06-13

### Added
- Initial release: `GhostBrokerClient`, `AuthClient`, `IntentClient`, `TradesClient`, `ReceiptClient`, `TelemetryClient`, `DelegationProofBuilder`.
- Authentication via DID challenge-response (`requestChallenge` / `verifyChallenge` / `authenticate(did, signer)`).
- Real-time telemetry WebSocket with auto-reconnect, status callbacks, and convenience handlers (`onSettled`, `onError`).
- Typed `GhostBrokerApiError` with `isAuthError` and `isRetryable` predicates.

[Unreleased]: https://github.com/zaikaman/GhostBroker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zaikaman/GhostBroker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zaikaman/GhostBroker/releases/tag/v0.1.0
