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

### T3-ONB-016 — TEE contract inputs are strictly snake_case; the SDK does not translate (P1)
Host dispatch reads the `input` field of the `generic-input` envelope and JSON-parses it against the Rust `Deserialize` derive's default field names. No implicit camelCase → snake_case translation. The orchestrator originally posted camelCase, causing `seal-intent: invalid JSON input: missing field 'institution_id'`, which the typed error path misclassified as a contract-not-registered cause. Fix: translate to snake_case at the network boundary in `t3-enclave/src/matching/blind-intent.ts` and `t3-enclave/src/matching/match-contract-client.ts`; keep the public TS interface camelCase.

### T3-ONB-018 — `verifyEcdsaVcSig` calls `verifyMessage` with a hex string, producing a non-canonical EIP-191 digest (P1)

`@terminal3/ecdsa_vc/dist/verifyEcdsaVc.js:50-54` calls

```js
const hash = ethers.solidityPackedKeccak256(["string"], [json]);   // 0x-prefixed hex, 66 chars
const recoveredAddress = ethers.verifyMessage(hash, signature);
```

`ethers.verifyMessage(message, sig)` always treats `message` as a generic message and applies EIP-191 to its UTF-8 bytes:

```
digest = keccak256("\x19Ethereum Signed Message:\n"
                 + toUtf8Bytes(String(message.length))
                 + toUtf8Bytes(message))
```

Because the SDK passes the hex string (length 66), the digest the SDK actually recovers from is

```
keccak256("\x19Ethereum Signed Message:\n" + "66" + "0x<64 hex>")
```

— NOT the canonical EIP-191 over the 32-byte payload:

```
keccak256("\x19Ethereum Signed Message:\n32" || hash)
```

A signer that produces the canonical digest (the obvious shape given `ethers.verifyMessage` is documented to be `personal_sign`) generates a signature whose recovered address does not appear in `proof.verificationMethod`. The SDK then throws `Signature does not correspond to verificationMethod in the proof` and `verifyVc` returns `isValid: false`. There is no doc, no release note, and no source comment warning that the digest layout diverges from the canonical EIP-191 — the only signal is the throw on line 56 and a passing `isValid: address === recoveredAddress` check on line 78 that happens to be case-sensitive (see T3-ONB-019).

**Reproduction** (minimal, no T3 network needed):

```js
// signer-side (what the docs imply)
const json = JSON.stringify(body);
const keccakOfJson = keccak256(jsonBytes);                 // 32 bytes
const digest = keccak256("\x19Ethereum Signed Message:\n32" + keccakOfJson);
const sig = eip191Sign(digest, privateKey);

// SDK-side (what verifyEcdsaVcSig actually does)
const hash = solidityPackedKeccak256(["string"], [json]); // 66-char hex string
const recovered = ethers.verifyMessage(hash, sig);         // wrong digest
// recovered !== expectedSignerAddress -> "Signature does not correspond..."
```

**Upstream fix proposal**: change `verifyEcdsaVcSig` to pass raw bytes:

```js
const recoveredAddress = ethers.verifyMessage(ethers.getBytes(hash), signature);
```

That makes the SDK recover from the canonical EIP-191 digest, which is what every signer in the ecosystem produces. With this fix the signer-side workaround becomes redundant and should be removed.

**Risk if upstream fixes it**: our workaround will silently start producing signatures the SDK can no longer recover. Pin a T3 SDK version (`@terminal3/verify_vc` or `@terminal3/ecdsa_vc`) in `package.json` and add a guard test that fails loud when `verifyMessage` recovers from the canonical digest rather than the hex-string digest. Treat the workaround as a T3-SDK-versioned capability, not a permanent shape.

### T3-ONB-019 — `verifyEcdsaVcSig` does case-sensitive `address === recoveredAddress`; issuer DID must be EIP-55 (P1)

`verifyEcdsaVc.js:53,78`:

```js
const address = getWalletAddress(data.issuer);                  // whatever case the DID carries
const recoveredAddress = ethers.verifyMessage(hash, signature); // always EIP-55 checksummed
...
return { isValid: address === recoveredAddress, ... };
```

`getWalletAddress` (in `utils.js`) returns the address substring as-is. `ethers.verifyMessage` always returns the EIP-55 checksummed form. The equality check is byte-exact and case-sensitive, so:

- `did:ethr:0x<lowercase>` → `address` is lowercase → `address === recoveredAddress` is **false** → `isValid: false` with message `Signature mismatch`.
- `did:ethr:0x<EIP-55>` → `address` is EIP-55 → matches → `isValid: true`.

The same case-sensitivity bites `verificationMethod.includes(recoveredAddress)` on line 55: a lowercase `verificationMethod` would never `includes()` an EIP-55 recovered address, producing `Signature does not correspond to verificationMethod in the proof` (T3-ONB-018's outer symptom).

There is no doc, release note, or fixture in the SDK showing the required casing. The only on-path signal is the throw on `verificationMethod.includes(...)` and the silent `isValid: false` from the equality check.

**Reproduction** (minimal):

```js
const wallet = ethers.Wallet.createRandom();
const did = `did:ethr:${wallet.address.toLowerCase()}`;  // lowercase DID
const signedVc = { ..., issuer: did, ... };
const result = await verifyVc(signedVc);
// -> { isValid: false, message: "Signature mismatch" }
const didEip55 = `did:ethr:${ethers.getAddress(wallet.address)}`;
const signedVc2 = { ..., issuer: didEip55, ... };
const result2 = await verifyVc(signedVc2);
// -> { isValid: true, message: "Verification successful" }
```

**Upstream fix proposal**: lowercase `address` and `verificationMethod` before comparing (or use `ethers.getAddress(...)` on both sides). With that, both casings would be accepted and the case-sensitivity would no longer be load-bearing.

**Risk if upstream fixes it**: the SDK would accept lowercase DID inputs. Our workaround produces an EIP-55 DID today; if the SDK later rejects EIP-55 (e.g. canonicalizes to lowercase), the issuer normalization would need to flip. Pin the SDK version and add a regression test that asserts both casings produce `isValid: true`.

