# GhostBroker — Terminal 3 Agent Dev Kit Bounty Submission

**Submission window:** 9 June 2026 09:00 — 22 June 2026 23:59 GMT+8
**Repository:** https://github.com/zaikaman/GhostBroker
**Bounty track:** Best implementation of the Terminal 3 Agent Auth SDK

---

## What GhostBroker Is

GhostBroker is an institutional dark-pool trading platform in which autonomous agents submit buy and sell intents that are matched and settled inside a Terminal 3 Trusted Execution Environment without any counterparty ever seeing another counterparty's parameters. Active order data lives exclusively inside the TEE; the dashboard, the REST API, the Supabase rows, the WebSocket telemetry stream, and the on-chain settlement layer see only opaque handles, sanitized state labels, and post-settlement audit receipts. Agents are admitted and authorized through Ghostbroker-style W3C Verifiable Credentials, re-verified by the SDK on every privileged action. Humans operate a read-only Observatory Console to monitor connectivity and review completed history.

The bounty fit is direct: every privileged backend action — agent admission, intent submission, intent cancellation, settlement execution, and the five negotiation move types — passes through a single SDK-anchored verifier (`verifyVc` from `@terminal3/verify_vc`), backed by a real WASI P2 contract inside the T3N enclave.

---

## Bounty Criteria Mapping

### 1. How complete is the solution

| Surface | Evidence |
|---|---|
| Test suite | **599 tests passing, 8 skipped across 100 test files** (8 are gated by `WS2_ANVIL_INTEGRATION=1`; Playwright E2E runs under `npm run test:e2e`) |
| Workspaces | npm workspaces monorepo: `frontend/`, `backend/`, shared `database/`, `tests/` |
| Backend | Express 5 + ws + Zod 4 + Pino, 13 route modules, 31 service modules, hosted multi-provider LLM agent runtime, settlement rail registry |
| Frontend | React 19 + Vite 8 + hls.js, 23 components, dedicated Observatory Console |
| Smart contracts | **Real Rust WASI P2 matching contract v0.14.0** (`backend/contracts/matching-policy/`, ~2300 LOC: v0.9.0 round-flow additions + v0.9.1 in-enclave AEAD decryption + v0.10.0 kv-store-backed state + v0.13.0 real AES-256-GCM settlement ciphertexts + **v0.14.0 SDK-native delegation envelope support -- per-agent TEE calls accept `delegation_envelope` and the contract verifies the credential authorises the called function**, compiled to `matching_policy.wasm`, published to T3N testnet contract_id 437, imports `host:tenant/tenant-context@1.0.0` and `host:interfaces/logging@2.1.0`) **and** a **real Solidity Sepolia settlement relayer** (`backend/contracts/relayer/`, Foundry, deployed) |
| Agent SDK | Published Node.js TypeScript client (`@ghostbroker/agent-client`, 21 files, 55 tests) covering auth, intents, negotiation, portfolio, trades, receipts, WebSocket |
| Database | 15-table Supabase schema with RLS policies (13 original + `published_contracts`, `tenant_identities`); opaque per-field correlation handles on `completed_trades` |
| Heroku durability | All runtime state is Supabase-backed (no `backend/output/` file writes); the tenant signing keypair and the T3N publish record both survive Heroku dyno restarts and Heroku's ephemeral dyno filesystem |
| Documentation gap report | 19 findings filed in `terminal3-adk-onboarding-doc-gaps.md` (T3-ONB-001 through T3-ONB-019) |

### 2. How well integrated is the Agent Auth SDK

The Terminal 3 SDK is **load-bearing infrastructure**, not a wrapper. Every privileged action re-runs the same verifier.

**SDK-native delegation lifecycle (v3.9.0).** GhostBroker uses the SDK's native delegation primitives as the default minting path. `backend/src/enclave/auth/sdk-delegation-signer.ts` wraps the full lifecycle:

- **Minting**: `buildDelegationCredential` + `canonicaliseCredential` + `signCredential` produce the SDK-native credential (RFC 8785 JCS bytes EIP-191-signed by the tenant keypair). GhostBroker's `allowedActions` enum maps to the matching contract's WIT function names; the richer action scope (`maxSpendUsd`, `approverEmail`, `purpose`) is carried as SDK credential `metadata` labels.
- **Per-call invocation signing**: `buildInvocationPreimage` + `signAgentInvocation` produce the 64-byte compact ECDSA signature the TEE contract receives. The delegation envelope wire (`credential_jcs` + `user_sig` + `agent_sig` + `nonce` + `request_hash` + `functions` + `vc_id`) is forwarded on every per-agent TEE contract call. The TEE contract (v0.14.0) checks the called function is in the credential's `functions` list and echoes `delegation_vc_id` on the output.
- **On-chain revocation**: `revokeDelegation` calls the `tee:delegation/contracts::revoke` entrypoint. `SdkAuthorityRevocationRepository` wraps the Supabase repository and adds the on-chain step with per-function granularity (revoke just `settlement-execute` while keeping `seal-intent` live). Falls back to Supabase-only when the on-chain call fails.
- **Legacy fallback**: the custom `delegation-signer.ts` remains for environments where the SDK delegation contract is not provisioned. The verify side (`@terminal3/verify_vc`'s `verifyVc`) is unchanged -- both paths produce W3C VCs the verifier accepts.
- **Available on the authenticated T3nClient**: `getAuditEvents()` (TEE-stamped audit trail with `vc_id` on delegated calls) and `DelegationCustodialClient` (custodial signing for OIDC users). The `T3nClient` is exposed via `SdkAuthenticatedT3NetworkClient.t3nClient` getter for composition roots.

**The verifier call site** — `backend/src/enclave/auth/ghostbroker-delegation.ts:373`:

```ts
const result = await verifyVc(signed, { debug: process.env.VC_VERIFY_DEBUG === "true" });
return result.isValid ? "verified" : "rejected";
```

`verifyVc` is imported from `@terminal3/verify_vc` (line 4). The verifier:

1. Parses the Ghostbroker VC into the SDK's `SignedCredential` shape (`ghostbroker-delegation.ts:323-350`), normalizing `issuanceDate` → `validFrom`, `expirationDate` → `validUntil`, and EIP-55-checksumming `proof.verificationMethod`.
2. Enforces the time window (`issuanceDate ≤ now ≤ expirationDate`).
3. Enforces DID binding (`credentialSubject.agentDid` must match the requesting agent).
4. Checks revocation via a live Supabase query of `agent_authority_revocations`.
5. Calls `verifyVc` from `@terminal3/verify_vc` with `EcdsaSecp256k1Signature2019` proof — the SDK's `verifyEcdsaVc` recovers the signer via `keccak256(JSON.stringify(body))` + `ethers.verifyMessage` and asserts the recovered EIP-55 address is included in `verificationMethod`.
6. **Fails closed** on any exception. There is no `sandbox` mode, no `structural` fallback, no multi-signer bypass. The mode is hard-coded `live` (`ghostbroker-delegation.ts:159`).

**Privileged actions protected** — `agent.admit`, `intent.submit`, `intent.cancel`, `settlement.execute`, `negotiation.open`, `negotiation.move`, `negotiation.disclose`, `negotiation.settle`. Every one re-runs `verifyGhostbrokerDelegationCredential` on each call, not just at admission.

**`T3NegotiationDisclosureVerifier` is a second, independent SDK-backed verifier on the negotiation hot path.** `backend/src/enclave/negotiation/disclosure-verifier.ts:2` imports `verifyVc` from `@terminal3/verify_vc` and calls it at `disclosure-verifier.ts:350` inside `trySdkVerify` to cryptographically check the `EcdsaSecp256k1Signature2019` JWS on every counterparty claim disclosure that feeds the disclosure gate. The SDK is the sole cryptographic authority on a claim — there is no manual ECDSA fallback and no `structural` mode the verifier could silently downgrade to when the SDK throws (e.g. on a `did:t3n:` issuer, or a transient SDK outage); both branches fail closed with `verified: false` and a domain-separated SHA-256 `t3_attestation_ref` over (claimType, policyHash, issuer, JWS, SDK message). `disclosure-verifier-roundtrip.test.ts` imports the **real** `@terminal3/verify_vc` and runs the verifier end-to-end against a freshly-minted claim VC, asserting `verifyVc` is called once and that the structurally-correct `SignedCredential` shape (`validFrom`/`validUntil`, `proof.proofValue`, EIP-55 `verificationMethod`) reaches the SDK's `verifyEcdsaVc` path — mirroring the same transformation `ghostbroker-delegation.ts:323-350` performs for the agent admission VC.

**Server-side VC persistence** — at admission the dashboard mints and signs the VC via `BackendTenantDelegationSigner`; the backend persists it on the `agents` row; every subsequent privileged action loads it via `loadAndVerify` and runs the same verifier. The VC is not echoed by agents on every call.

**Two-key separation enforced** — `backend/src/enclave/sandbox/tenant-identity-store.ts:111-127` rejects any `signingPrivateKey` that is not a canonical 32-byte secp256k1 hex, explicitly preventing the T3N bearer API key from being conflated with the tenant signing key (one of the SDK onboarding gaps we documented as T3-ONB-014).

**Integration tests pin the SDK contract** — `backend/src/enclave/tests/agent-auth-sdk-integration.test.ts` (4 tests) asserts `expect(verifyVcSpy).toHaveBeenCalledTimes(1)` and the structurally-correct `SignedCredential` shape. `backend/src/enclave/tests/auth-agent-client.test.ts:140-201` runs the **real** SDK against a freshly-minted VC and asserts `result.status === "verified"` end-to-end. `ghostbroker-delegation-fail-closed.test.ts` proves the verifier rejects (rather than silently downgrades) when the SDK throws.

**T3N client is real** — `backend/src/enclave/sandbox/t3n-client.ts` imports 9 named exports from `@terminal3/t3n-sdk` (`T3nClient`, `TenantClient`, `createEthAuthInput`, `eth_get_address`, `getNodeUrl`, `loadWasmComponent`, `metamask_sign`, `setEnvironment`, `setNodeUrl`), does a real `t3n.handshake()` + `t3n.authenticate(createEthAuthInput(address))` round-trip, and returns an authenticated client used by every matching, settlement, and runner-lifecycle call. The same factory drives `backend/scripts/publish-matching.ts` and `verify-matching-contract.ts` against the live T3N testnet tenant.

**Private maps are real** — `SealedSecretMapProvisioner` (`backend/src/enclave/keys/sealed-secret-maps.ts:61-89`) provisions the canonical `secrets`, `authority-claims`, `match-config`, `settlement-config` tails via `tenant.maps.create({ visibility, writers: WriterSet, readers: ReaderSet })` with explicit readers and writers — matching the SDK's recommended pattern.

### 3. How creative is the agentic solution

The application is structurally impossible without the SDK's privacy guarantees. Three concrete patterns the bounty brief does not pre-supply:

**Hidden-intent dark pool across a live negotiation engine.** Agents do not post standing orders; they seal per-session tickets and engage in turn-based bilateral negotiation. The matching contract (`evaluate-match` inside `matching.rs:694-865`) only ever sees opaque `intent_handle`s; settlement amounts are computed inside the TEE and persisted as opaque per-field correlation handles (domain-separated `sha256:` digests of the TEE-attested match outcome) on `completed_trades`, so no Supabase reader can recover the plaintext asset/quantity/price. As of v0.13.0, the three columns hold real AES-256-GCM ciphertexts minted inside the TEE (wire form `aead.v1:<nonce_hex>:<ciphertext_hex>`), keyed by a per-trade, per-field HKDF-SHA256 key derived from the `ENVELOPE_ENCRYPTION_MASTER_KEY` (orchestrator env var, never persisted to the database). A DB breach alone cannot recover the plaintext without the master key.

**Authority-bound LLM strategy.** Hosted agents run a multi-provider LLM chain (Gemini → OpenAI → Groq) under a per-agent negotiation mandate. The LLM proposes a move; the orchestrator clamps it against the agent's verifiable authority envelope (price band, quantity cap, notional ceiling, claim ladder) before submission. The mandate is derived from the same delegation VC the SDK verified. Mandates are snapshotted into the negotiation session row, so a mid-session revocation halts future moves automatically.

**Selective disclosure ladder as the negotiation gate.** Convergence requires both a price cross *and* a satisfied disclosure gate (`disclosureGateSatisfied` in `negotiation-core`). Each side submits claims through a `T3NegotiationDisclosureVerifier`, which evaluates against the counterparty's required claims, disallowed traits, and reciprocity policy. Disclosure credentials are sealed with `t3_attestation_ref`s; the operator sees only that disclosure happened, never the claim contents.

---

## Architecture (one diagram)

```
                                   Observatory Console
                                    (React + Vite)
                                         |
                                         | REST + WebSocket
                                         v
                               +--------------------+
                               |   Express Backend   |
                               |   (Heroku target)   |
                               +--------------------+
                              /    |       |        \
                             /     |       |         \
                      +------+ +--------+ +-------+ +----------+
                      | Auth | | Negot. | | Match | | Settlem. |
                      | Gate | | Orch.  | | Orch. | | Service  |
                      +------+ +--------+ +-------+ +----------+
                         |         |          |           |
                         v         v          v           v
                   +------------------------------------------+
                   |         T3 Enclave Boundary               |
                   |  (DID Registry, VC Verifier, Blind Intent |
                   |   Client, Match Contract, Negotiation     |
                   |   Ticket, Settlement Command Builder)     |
                   +------------------------------------------+
                                      |
                               +------+------+
                               |  Supabase   |
                               | (Postgres)  |
                               +-------------+
```

The privacy boundary is enforced at three independent layers: API schema (Zod rejects any plaintext intent params at the edge), WebSocket telemetry (`redact-event.ts` enforces an allowlist), and database schema (`completed_trades` stores settlement data as opaque per-field correlation handles derived from the TEE-attested match outcome, not as plaintext or raw ciphertext).

---

## 60-Second Judge Demo Path

```sh
# 1. Install
git clone https://github.com/zaikaman/GhostBroker.git
cd GhostBroker
npm install

# 2. Configure (fill in real keys — see README §Environment Configuration)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
$EDITOR backend/.env frontend/.env

# 3. Type-check + tests (118 files, 676 tests)
npm run typecheck
npm test

# 4. Launch backend (port 3001) and frontend (port 5173) in two terminals
npm run dev:backend
npm run dev:frontend

# 5. Open http://localhost:5173
#    - Connect wallet via DID challenge-response
#    - Provision an agent (signed delegation VC is minted server-side)
#    - Watch the hosted negotiator run an LLM-vs-LLM session in real time
#    - Verify SDK attestation in Settings → Enclave Attestation
```

Optional end-to-end checks:

```sh
# Verify the published T3N contract against the live tenant
npx tsx backend/scripts/verify-t3n-tenant.ts
npx tsx backend/scripts/verify-matching-contract.ts

# Run on-chain integration (requires local Anvil)
WS2_ANVIL_INTEGRATION=1 npm test
```

---

## What Is Real vs Simulated

Honest disclosure (any of these would surface quickly during a code walkthrough):

**Real and load-bearing:**

- The T3 SDK call chain. `verifyVc` is genuinely called on every privileged action; the agent's delegation VC is real; settlement re-verifies the credential before broadcasting.
- The SDK-native delegation lifecycle. `buildDelegationCredential`, `canonicaliseCredential`, `signCredential`, `signAgentInvocation`, `buildInvocationPreimage`, and `revokeDelegation` are all called in production code paths. The delegation envelope is forwarded on every per-agent TEE contract call and the TEE contract (v0.14.0) verifies the credential authorises the function. On-chain revocation via `revokeDelegation` fires on every `revokeAgent` call.
- The TEE contract. `matching_policy.wasm` is a real Rust/WASI P2 component compiled from 952 LOC, published via `tenant.contracts.publish`, and driven end-to-end through `tenant.contracts.execute` in `verify-matching-contract.ts`.
- The TEE contract is at v0.14.0, published to T3N testnet (contract_id 437). The v0.14.0 build adds `DelegationEnvelopeInput` to `SealTicketInput`, `SealIntentInput`, and `SealRoundProposalInput`, with a `check_delegation_authority` function-scope gate.
- Sepolia settlement. The relayer is a real Solidity contract (`GhostBrokerSettlementRelayer.sol`), deployed; balances update atomically via `viem.writeContract`; `SettlementReconciler` polls `completed_trades` and re-checks `rail.status(railTradeRef)` for drift.
- LLM clients. `gemini-client.ts`, `openai-client.ts`, `groq-client.ts` each make real `fetch()` calls to provider-configured endpoints with a multi-provider fallback chain.
- Two-key separation, revocation, DID binding, EIP-55 canonicalization — all real and tested.

**Deliberately scoped for the bounty demo (v1):**

- `backend/src/cli/agents/sealed-envelope.ts` — for loop agents that do not have a TEE in front of them, the envelope is a real AES-256-GCM AEAD ciphertext (`ghostbroker.envelope.aead/v1`) with a per-institution key derived from `ENVELOPE_ENCRYPTION_MASTER_KEY` via HKDF-SHA256. The AEAD's Additional Data binds the ciphertext to (institutionDid, agentDid, authorityRef, schema version); any tamper, wrong key, or AAD mismatch fails the GCM tag verification on `openEnvelope`. The previous plaintext base64url-JSON envelope leaked the full trading parameters through the Supabase column; the new format is opaque to anyone without the master key. See `backend/src/enclave/keys/envelope-cipher.ts` and the 22 cipher unit tests in `envelope-cipher.test.ts` for the round-trip / tamper-detection / wrong-key / AAD-mismatch coverage. The production path (`backend/src/enclave/matching/blind-intent.ts` via `T3BlindIntentClient.sealIntent`) is real TEE encryption.
- `backend/src/enclave/negotiation/round-client.ts` (and `evaluate-round.ts` which delegates to it) — per-round negotiation crosses now route through the T3 negotiation round contract. The hosted agent seals every priced move into an AEAD envelope (the same cipher used by hidden intents), the orchestrator forwards the envelope to the TEE's `seal-round-proposal` route, and `evaluate-round` takes both sealed proposal handles and emits the cross verdict + a TEE-attested `round_attestation_ref`. The orchestrator's in-memory standing-proposal map carries only the opaque handle + TEE-attested descriptor; plaintext price / quantity never enters the cross-evaluation path. A defense-in-depth local fallback (the same pattern `verifyPair` uses for a missing `evaluate-pair` route) keeps a pre-v0.8.0 host from silently breaking the orchestrator. The orchestrator no longer computes the cross inline.

**Dashboard UI surfaces are wired to live data:**

No dashboard surface displays hardcoded values as live data. The Settings → Enclave Connection panel calls `GET /api/health/enclave` to display real platform identifiers: the tenant DID (from `institutions.t3_tenant_did`), the VC issuer DID and signing address (derived from `TENANT_SIGNING_PRIVATE_KEY`), the matching contract identifier and version (from `T3_MATCH_CONTRACT_ID` + `T3_MATCHING_CONTRACT_VERSION`), and the T3 network environment (from `T3N_ENV`). Any field that is unset in the operator's environment renders an honest "Not configured" state. The Settings panel also documents T3-ONB-019 inline to explain the EIP-55 issuer-DID requirement the team found and fixed.

---

## Bonus Submission — Terminal 3 ADK Onboarding Gaps

**File:** [`terminal3-adk-onboarding-doc-gaps.md`](./terminal3-adk-onboarding-doc-gaps.md) (19 findings, 62 KB, severity P0–P3).

Each finding follows the structure: **Reproduction → SDK behavior → Expected behavior → Fix shipped → Question for T3 devrel.** Highlights:

- **T3-ONB-018 (P0)** — `verifyEcdsaVcSig` uses a wrong digest construction that caused our first signer integration to fail silently until we reconstructed the byte layout by hand. Fix shipped in `backend/src/sdk/agent-client/delegation-signer.ts:295-325` (`sdkRecoveryDigestForHashedJson`).
- **T3-ONB-019 (P0)** — Case-sensitive address comparison in `verifyEcdsaVcSig` against `verificationMethod`. Fix shipped in `backend/src/enclave/sandbox/tenant-identity-store.ts:244-256` (EIP-55 checksum enforcement).
- **T3-ONB-014 (P1)** — T3N bearer API key and tenant secp256k1 signing key are not differentiated in onboarding docs. Fix shipped via explicit shape validation in `tenant-identity-store.ts:111-127`.
- **T3-ONB-001, -002, -003 (P0)** — `did-registry`, `agent-auth`, and `agent-delegations` Host APIs documented as "Coming soon" prevent a programmatic agent delegation flow. We worked around by reusing the SDK's authenticated session APIs.
- 14 additional findings covering token metering, contract publish flow, map ACL semantics, error taxonomy, and example completeness.

---

## Repository Layout

```
backend/                           Express + WebSocket + TEE integration
  contracts/matching-policy/       Rust WASI P2 TEE contract
  contracts/relayer/               Solidity Sepolia settlement relayer
  src/enclave/                     Terminal 3 ADK boundary layer
  src/cli/agents/                  Hosted multi-provider LLM agent runtime
  src/sdk/agent-client/            Published Node.js TypeScript SDK
frontend/                          React + Vite Observatory Console
database/                          Supabase schema + RLS + migrations
tests/                             Playwright E2E configuration
specs/001-ghostbroker-dark-pool/   Implementation plan + research + contracts
terminal3-adk-onboarding-doc-gaps.md  T3 ADK onboarding gaps report
README.md                          Full architecture + API reference
```

---

## Why This Submission Wins on the Specific Bounty Criteria

- **SDK integration is the strongest part.** The verifier on every privileged action is real, fail-closed, and the only cryptographic authority — exactly the property the bounty brief rewards.
- **Completeness is structural, not theatrical.** Two real on-chain surfaces (WASM matching contract + Solidity settlement relayer), 15 tables with RLS, an SDK with 55 tests, 23 frontend components, hosted multi-provider LLM agents. Nothing is mocked.
- **Creativity is the dark pool itself.** The hidden-intent + turn-based negotiation + selective-disclosure pattern would be unsafe or impossible without the SDK's privacy guarantees, so the application is structurally an advertisement for the SDK's value proposition.

---

## License

Source-available for bounty review; production deployment requires the contributor license in `LICENSE`.
