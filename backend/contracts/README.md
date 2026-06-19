# GhostBroker TEE Contracts

This workspace holds the TEE (Trusted Execution Environment) smart
contracts that run inside the Terminal 3 (T3) enclave surface for
the GhostBroker dark pool. They are compiled to WASI Preview 2
components and published to the T3N tenant at runtime, where they
back the orchestrator's seal + match pipeline.

## Layout

```
contracts/
├── package.json                 — npm script aliases
├── README.md                    — this file
└── matching-policy/             — the dark-pool seal + match contract
    ├── Cargo.toml               — Rust crate (wit-bindgen 0.49, sha2 0.10, serde)
    ├── src/
    │   ├── lib.rs               — entrypoint, Guest impl, IO shapes
    │   └── matching.rs          — seal-intent + evaluate-match logic
    └── wit/
        ├── world.wit            — public interface: seal-intent, evaluate-match
        └── deps/                — vendored host:tenant + host:interfaces WIT
```

## Build

The matching contract compiles to a raw core WASM module (not a
full component) at `target/wasm32-wasip2/release/matching_policy.wasm`.
The T3N host accepts core modules as well as components, so we
don't need `wasm-tools` / `wasm-component-ld` in the toolchain.

```sh
# from the repo root
cd contracts/matching-policy
cargo build --target wasm32-wasip2 --release
# or, via the npm alias:
npm --prefix contracts run build:matching
```

First build pulls + compiles `wit-bindgen`, `serde`, `sha2`, etc.
(~30 seconds). Incremental builds are < 1 second.

## Publish

```sh
# from the repo root
npx tsx scripts/publish-matching.ts
```

Reads `backend/.env` for the `T3N_API_KEY` + `T3_TENANT_DID` and
publishes the compiled WASM under tail `matching` (the canonical
name the GhostBroker orchestrator hits at
`/contracts/matching/blind-intents` and `/contracts/matching/evaluate`).
Idempotent: re-publish with the same version is a no-op. To push a
new version, set `T3_MATCHING_CONTRACT_VERSION` (env wins over
`.env`).

```sh
T3_MATCHING_CONTRACT_VERSION=0.2.0 npx tsx scripts/publish-matching.ts
```

## Verify

```sh
npx tsx scripts/verify-matching-contract.ts
```

Calls `seal-intent` and `evaluate-match` against the live tenant
and prints the opaque handles / outcome refs the T3N TEE returns.
If either call returns a `not_found` or `bad_request`, the
published contract is the wrong version or the T3N session is
stale.

## Contract semantics

`seal-intent` mints:
- `intent_handle` — `intent_<32 hex chars>` = SHA-256 of
  `institution_id|agent_did|encrypted_intent|authority_ref|correlation_ref`.
  Deterministic, so the orchestrator can dedupe accidental
  re-seals.
- `execution_ref` — `t3exec_<32 hex chars>` from a fresh
  monotonic counter (per-instance, per-call).

`evaluate-match` mints:
- `outcome_ref` — `outcome_<32 hex chars>` = SHA-256 of
  `buy_intent_handle|sell_intent_handle|correlation_ref`.
- `encrypted_trade_fields_ref` — `t3fields_<32 hex chars>` = SHA-256
  of `buy_intent_handle:sell_intent_handle`. The orchestrator
  stores the actual settlement fields under this ref.
- `expires_at` — now + 300s, formatted ISO 8601 UTC. Matches the
  orchestrator's default intent TTL.
- `status` — `"matched"` when the buyer's bid crosses the seller's
  ask (`buy_price >= sell_price`) and all price/quantity fields are
  valid positive integers; `"no_match"` otherwise. As of v0.2.0 the
  enclave is the match authority.
- `matched_quantity` — `min(buy_quantity, sell_quantity)` on a
  `matched` outcome (decimal string); empty on `no_match`.
- `execution_price` — deterministic midpoint `(buy_price +
  sell_price) / 2` rounded half-up (decimal string); empty on
  `no_match`.

The backend orchestrator is a verifier/orchestrator around the
enclave outcome: it filters obvious non-candidates (same
institution, same side, different asset) locally, then trusts the
enclave's `matched`/`no_match` decision and the returned
`matched_quantity` / `execution_price` for settlement. It never
recomputes the crossing, fill, or price locally.

## Adding a new contract

1. `mkdir contracts/<name>-policy/src contracts/<name>-policy/wit/deps`
2. Copy `contracts/matching-policy/wit/deps/host-*` (they're
   identical for every contract in the workspace).
3. Author `Cargo.toml` (copy the matching one) and `src/lib.rs` +
   `src/<name>.rs`.
4. Define your `wit/world.wit` package — use a unique package
   name (`ghostbroker:<name>-policy@0.1.0`) so the host can
   disambiguate.
5. `cargo build --target wasm32-wasip2 --release` from inside
   the new folder.
6. Add a `publish-<name>.ts` script under `scripts/` modeled on
   `publish-matching.ts`. The `tail` you pick is what the
   orchestrator hits in the URL path.
7. Add npm aliases to `contracts/package.json`.
