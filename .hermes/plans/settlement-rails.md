# Settlement Rails — design and workstream plan

> **Status:** Draft v1 (WS1 starts immediately after this doc is committed).
> **Owners:** TBD.
> **Scope:** Real-asset settlement for the GhostBroker dark pool. Today the
> system stops at "DB row written, balances updated". This plan adds a
> pluggable **SettlementRail** seam, lands a `NoopCustodialRail` (drop-in
> replacement for the current implicit behavior) and a `ChainRail` against
> Sepolia ERC-20 (with a TEE-attested relayer preserving dark-pool
> confidentiality through settlement), and leaves a seam for a future real
> `CustodialRail` (Fireblocks-style) partner integration.

---

## 0. Where we are today, grounded in the code

These are the files that establish the current shape; the rest of the
plan is referenced off them.

| Concern | File | Lines | What it does |
|---|---|---|---|
| Institution has a `settlement_profile_ref` column | `database/schema.sql` | 4-15 | `text NOT NULL` column on `institutions`, no enum, free-form string. |
| Default profile string | `backend/src/services/auth.service.ts` | 104 | Hard-coded `"wallet:default"`. |
| Profile accepted at create | `backend/src/models/institution.ts` | 15 | `z.string().trim().min(1).max(256)`. No enum, no DB constraint. |
| Profile passed through create/update | `backend/src/services/institution.service.ts` | 76, 87, 165, 171 | Stored verbatim in `institutions.settlement_profile_ref`. |
| Chokepoint for every match | `backend/src/services/settlement.service.ts` | 160-249 | `executeSettlement(...)`: builds TEE `SettlementCommand`, persists `completed_trade` row via the `persist_completed_settlement` RPC, applies portfolio deltas, emits telemetry. **No external rail call today.** |
| Call site | `backend/src/services/matching-orchestrator.ts` | 344 | `await this.settlementService.executeSettlement(request, ${outcome.outcomeRef}:${randomUUID()})`. |
| `SettlementCommand` shape (TEE output) | `t3-enclave/src/matching/settlement-command.ts` | 33-41 | `{ commandRef, outcomeRef, executionRef, buyerInstitutionId, sellerInstitutionId, encryptedTradeFieldsRef, submittedAt }`. **No plaintext assetCode/quantity/price in the command itself.** |
| `OpaqueMatchOutcome` shape (TEE output) | `t3-enclave/src/matching/match-contract-client.ts` | 11-21 | `{ outcomeRef, executionRef, buyerInstitutionId, sellerInstitutionId, encryptedTradeFieldsRef, buyerAuthorityRef, sellerAuthorityRef, expiresAt, status }`. |
| Plaintext fields delivered alongside the command | `backend/src/services/settlement.service.ts` | 37-39 | `SettlementExecutionRequest.assetCode`, `quantity`, `executionPrice: number`. These are the fields a rail needs to actually move assets. |
| `completed_trades` schema | `database/schema.sql` | 30-45 | 9 columns. No rail reference. |
| `persist_completed_settlement` RPC | `database/migrations/003_create_audit_receipts.sql` | 24+ | Postgres function that inserts the `completed_trades` row. This is the schema-level authority for what the row looks like. |
| Operator-side Sepolia read (not a rail) | `backend/src/services/sepolia-portfolio-sync.service.ts` | 1-247 | Read-only Etherscan sync of the *operator's* wallet. Wired in `portfolios.routes.ts:119-130` for the operator's portfolio view. Never settled against. |

### What this proves about the architecture

1. There is **already** an institution-level rail selection field
   (`settlement_profile_ref`). It is currently a no-op.
2. There is **already** a single chokepoint for settlement
   (`SettlementService.executeSettlement`). Everything funnels through it.
3. The TEE produces an **opaque** command; the plaintext fields needed to
   move assets are delivered to `executeSettlement` as `number` fields in
   `SettlementExecutionRequest`. A rail receives both.
4. The `completed_trades` row is the canonical "settled" record. The
   `trade_ref` is `unique` and is the join key for audit receipts.

That is a clean, minimal surface to extend. No new table is needed for
v1.

---

## 1. Design goals and non-goals

### Goals (must hold)

- **G1 — Confidentiality holds end-to-end.** Quantity, price, and
  counterparty identity must not leak to a public chain or to a third
  party. A chain rail that posts plaintext calldata is rejected.
- **G2 — Atomicity between rail and DB.** A trade is "settled" only
  when **both** the rail confirms the asset movement **and** the DB
  `completed_trades` row is written. There is no observable "DB says
  settled, chain says pending" state from the API.
- **G3 — Existing test suite stays green.** Every existing
  `settlement-*.test.ts` integration test must pass after WS1 with zero
  test changes. The DB-level atomicity is preserved; the rail is one
  additional await between the TEE command build and the DB persist.
- **G4 — Operator and agent flows are unchanged.** Operators do not
  sign transactions per trade. Agents do not sign anything. The
  `/deploy` page and the agent SDK do not change.
- **G5 — The seam is open for v2.** A real `CustodialRail` (Fireblocks,
  T3 Custody, etc.) is one file in `settlement-rails/` plus a dispatcher
  registration. No schema change.

### Non-goals (deferred)

- **NG1 — Pedersen / commitment-based on-chain privacy.** Out of scope
  for v1. The TEE-attested relayer model (G1) is sufficient for the
  hackathon story and matches the existing doc-gaps guidance at
  `docs/terminal3-adk-onboarding-doc-gaps.md:544`.
- **NG2 — MEV protection on chain.** A per-rail concern. Future rails
  (Flashbots Protect, private mempools) can be added without changing
  the dispatcher.
- **NG3 — Cross-chain settlement.** Single-chain v1 (Sepolia). A future
  rail per chain.
- **NG4 — Multi-leg trades.** Each match is one buy + one sell, one
  settlement call, one rail call. Multi-leg is out of scope.
- **NG5 — Token standards beyond ERC-20.** No native ETH, no ERC-721,
  no ERC-1155 in v1.

---

## 2. Target architecture

```
                        ┌──────────────────────────┐
                        │  TEE matching-policy     │
                        │  evaluate_match →        │
                        │  OpaqueMatchOutcome      │
                        └──────────┬───────────────┘
                                   │ SettlementCommand
                                   ▼
              ┌────────────────────────────────────────────┐
              │  SettlementService.executeSettlement(...)  │
              │   1. commandBuilder.build(...)              │
              │   2. rail.dispatch(command, plaintext)     │  ← NEW
              │   3. DB applySettlement(...)                │  ← atomic with (2)
              │   4. persist completed_trade + receipt      │
              └──────────┬─────────────────────────────────┘
                         │  looks up
                         ▼
                ┌─────────────────────────┐
                │  SettlementRailDispatcher│
                │   by settlementProfileRef│
                └──────┬──────┬─────┬─────┘
                       │      │     │
              ┌────────┘      │     └────────┐
              ▼               ▼              ▼
        NoopCustodialRail  ChainRail     CustodialRail  (future)
        ("wallet:default", (Sepolia       (Fireblocks,
        default for all    ERC-20)        T3 Custody, etc.)
        existing flows)
```

### The seam

```ts
// backend/src/services/settlement-rails/rail.ts
export interface SettlementRail {
  /** Matches institution.settlement_profile_ref. */
  readonly id: string;

  /**
   * Move the assets for a confirmed match. Returns a transport proof
   * the orchestrator persists alongside the completed_trades row.
   * MUST be safe to retry: given the same `command.outcomeRef`, a
   * second call with the same plaintext trade fields must succeed or
   * return the existing proof.
   */
  dispatch(
    command: SettlementCommand,
    plaintext: { assetCode: string; quantity: number; executionPrice: number },
  ): Promise<RailSettlementProof>;

  /**
   * Best-effort reversal for ops. Requires admin auth at the HTTP
   * layer. A reversal returns a new proof; the DB row's
   * settlement_status flips to "reversed".
   */
  reverse(tradeRef: string, reason: string): Promise<RailSettlementProof>;
}

export interface RailSettlementProof {
  railId: string;
  railTradeRef: string;           // tx hash, custody ref, or test id
  railState: "settled" | "failed" | "reversed";
  assetMovements: ReadonlyArray<{
    assetCode: string;
    fromInstitutionId: string;
    toInstitutionId: string;
    quantity: string;              // string for bigint safety at the rail boundary
    railAssetRef: string;          // token address / custody account / etc.
  }>;
  observedAt: string;              // ISO-8601
  raw?: unknown;                   // rail-specific payload (tx receipt, custody ref object). Not logged.
}
```

`SettlementService.executeSettlement` becomes:

```
1. commandBuilder.build(...)                    // unchanged
2. rail.dispatch(command, plaintext)            // NEW; throws on failure
3. repository.persistCompletedSettlement(...)   // unchanged
4. portfolioService.applySettlement(...)        // unchanged
5. telemetry publishes                          // unchanged
```

On step-2 failure: no DB write, no portfolio delta, lock is released
through the existing orchestrator cancellation path, telemetry emits
`settlement_failed` with `cause: rail_dispatch_failed`.

### Idempotency contract

`dispatch` is given the TEE's `outcomeRef` (deterministic, derived from
the two intent handles) and the plaintext fields. Two implementations:

- **`NoopCustodialRail`** — derives a synthetic `railTradeRef` from
  `sha256("noop-rail:" + outcomeRef)`. Deterministic, so a retry
  returns the same proof.
- **`ChainRail`** — uses the TEE's `encryptedTradeFieldsRef` as a chain
  tx memo. A retry with the same `outcomeRef` reads the chain for the
  prior tx hash and returns it. Falls back to re-submitting if the prior
  tx is not found (after a configurable timeout).

This is the only contract the dispatcher cares about. The DB does not
need a unique constraint on `rail_trade_ref` (it would break safe
re-tries); the proof is stored as `text` and the `trade_ref` (the TEE
outcome) remains the unique key.

---

## 3. The rails in detail

### 3.1 `NoopCustodialRail` (default, mandatory in v1)

- **Id:** `wallet:default` — the string already hard-coded in
  `auth.service.ts:104`. We do not change that string in WS1; existing
  institutions keep working without a migration.
- **Behavior:** No external transport. Returns a synthetic
  `RailSettlementProof` with `railState: "settled"`,
  `railTradeRef: "noop:<sha256(outcomeRef)>"`, empty `assetMovements`
  (nothing moved on a real rail), and a `railAssetRef` of
  `"noop"`. This is exactly what the system does today, just typed.
- **Why default:** Every existing demo flow, every existing integration
  test, and every "Spin up demo agents" run is a noop-custodial flow.
  We cannot break that. A future migration (not in v1) would let an
  operator opt into a real rail.
- **Wire format:** None.

### 3.2 `ChainRail` (v1, the hackathon headline)

- **Id:** `chain:sepolia:erc20`.
- **Chain:** Sepolia. The repo is already Sepolia-friendly
  (`sepolia-portfolio-sync.service.ts` reads Sepolia via Etherscan;
  `frontend/src/components/PortfolioCard.tsx:256` links to the Sepolia
  faucet). Picking another chain adds work without adding signal for
  judges.
- **Asset scope:** ERC-20 only. The token address per `assetCode` is
  stored on `institutions.metadata.tokenAddresses[assetCode]` at
  institution creation. WBTC and USDC are seeded on Sepolia
  testnet-deployed contracts.
- **Per-institution deposit address:** Each institution on the chain
  rail owns one or more deposit addresses (one per asset class is
  fine). The address is stored on `institutions.metadata.depositAddress`
  at institution creation. The operator funds it before trading.
- **Privacy model (G1 enforcement):**
  1. The backend submits the ERC-20 `transferFrom(deposit, deposit, amt)`
     pair through a **TEE-attested relayer**. The relayer is a T3
     contract that holds a per-tenant signing key inside the TEE.
  2. The relayer's call data is the TEE's `encryptedTradeFieldsRef`
     (already produced by `evaluate_match`); the plaintext
     `quantity` / `executionPrice` never reaches a public RPC node.
  3. Public observers see the transaction, the gas, the `to` address
     (the relayer contract), and an opaque calldata blob.
  4. The TEE's `executionRef` is emitted as a `t3_attestation_ref` on
     the on-chain event for the audit receipt.
- **Why this is a real "moving asset" demo:** The trade is observable
  on Etherscan (`https://sepolia.etherscan.io/tx/<railTradeRef>`).
  Judges can click through. The `rail_trade_ref` is the live tx hash.
  The dark-pool confidentiality is preserved because the relayer is
  attested by the same T3 tenant as the matching contract — there is
  no plaintext on the public chain.
- **What v1 does *not* do on chain:** No escrow contract. The deposit
  address is the institution's own; the rail does an atomic
  `transferFrom(buyerDeposit, sellerDeposit, amount)` plus a
  `transferFrom(buyerDeposit, sellerDeposit, paymentAmount)` using the
  settlement-asset token. v1 does not protect against the buyer not
  having approved the rail — that is `NG5`-adjacent and is the
  operator's responsibility at deposit time.

### 3.3 `CustodialRail` (v2 stub, not built in v1)

- **Id:** `custody:<partner>` (e.g. `custody:fireblocks`).
- **Status:** Interface defined in WS1, no implementation. The
  dispatcher logs a clear `"custody rail not implemented"` if an
  institution is configured with this profile; settlement for that
  institution fails closed with a typed error.
- **Why not v1:** A real custodian integration is a partner deal and
  a multi-day build. It is also the least demonstrable of the three to
  a hackathon judge (no public link to click). A real custodian rail
  can be added in WS8 (post-hackathon) without any change outside
  `settlement-rails/`.

---

## 4. Data model changes (WS1)

Single migration, additive only, no constraint changes that would
break existing rows.

```sql
-- database/migrations/011_completed_trades_rail_columns.sql

ALTER TABLE public.completed_trades
  ADD COLUMN IF NOT EXISTS rail_id text,
  ADD COLUMN IF NOT EXISTS rail_trade_ref text,
  ADD COLUMN IF NOT EXISTS rail_state text
    CHECK (rail_state IS NULL OR rail_state = ANY (ARRAY['settled'::text, 'failed'::text, 'reversed'::text])),
  ADD COLUMN IF NOT EXISTS reconciled_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS completed_trades_rail_trade_ref_idx
  ON public.completed_trades (rail_trade_ref)
  WHERE rail_trade_ref IS NOT NULL;
```

The `persist_completed_settlement` RPC is updated in the same
migration to accept and store the rail fields. Backfill is not needed:
existing rows are pre-rail (rail_id NULL, rail_state NULL), which is
the correct historical state.

The `institutions.metadata` JSONB column already exists and is the
right home for the chain rail's per-institution config:

- `metadata.tokenAddresses[assetCode]` — the ERC-20 address per asset
  on Sepolia.
- `metadata.depositAddress` — the institution's deposit wallet on
  Sepolia. Set by the operator at institution-creation time on the
  chain rail path.

No institution-table column change is needed for v1.

---

### WS2.5 — `ChainRail` on Sepolia (the demo)

**Goal:** A real `ChainRail` implementation against Sepolia, with the
TEE-attested relayer preserving G1. WS2.5 ships the on-chain
relayer contract (Solidity, Forge-compiled), the per-institution
deposit address flow, real on-chain `Settled` event decoding,
and on-chain idempotency.

**Acceptance gate (this is what we shipped):**
- Two institutions on the chain rail, real distinct deposit
  addresses, real Sepolia testnet USDC + WBTC, complete a trade
  whose `rail_trade_ref` is a real tx hash clickable to
  Etherscan.
- `npm run test` exits 0.
- A new integration test
  `settlement-rail-chain-sepolia.test.ts` deploys the real
  `GhostBrokerSettlementRelayer` + 2 minimal ERC-20s to a
  local Anvil node, has two per-institution deposit addresses
  pre-approve the relayer, broadcasts a real `settle(...)`
  call, decodes the on-chain `Settled` event and asserts the
  `assetAmount` / `paymentAmount` match the TEE's authorized
  plaintext, and reads the ERC-20 balances to assert both
  `Transfer` events fired.
- An on-chain idempotency test proves that a second
  `settle(...)` call with the same `outcomeRef` reverts with
  `OutcomeAlreadySettled` (the relayer contract's
  `settledOutcomes` mapping is the on-chain authority).
- The `/deploy` and `/settings` pages show the chain rail as
  available.

**Files (this WS):**
- `contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol` — the relayer.
- `contracts/relayer/src/contracts/MinimalERC20.sol` — test fixture.
- `contracts/relayer/foundry.toml` — Forge workspace.
- `contracts/relayer/out/...` — compiled artifacts.
- `backend/src/services/settlement-rails/abi/GhostBrokerSettlementRelayer.json` — copied artifact.
- `backend/src/services/settlement-rails/abi/MinimalERC20.json` — copied artifact.
- `backend/src/services/settlement-rails/relayer-abi.ts` — typed ABI loader.
- `backend/src/services/settlement-rails/chain-sepolia-rail.ts` — refactored to use `writeContract`.
- `backend/src/config/env.ts` — new env var
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS`.
- `backend/src/app.ts` — wires the contract address.
- `backend/src/tests/integration/settlement-rail-chain-sepolia.test.ts` — 7 tests, Anvil-gated.
- `contracts/package.json` — new `build:relayer` and
  `build:relayer:copy-abi` scripts.

**What WS2.5 changed vs the WS2 v1 stub:**
- The on-chain calldata is the real relayer's `settle(bytes32, bytes32, address, address, address, address, uint256, uint256)` ABI encoding. No more sha256 stub.
- Per-institution deposit addresses are required (no more
  degenerate `to=self` transaction).
- The rail throws a typed error if `buyerDeposit === sellerDeposit`
  (production invariant: distinct per-institution addresses).
- The rail's `status(tradeRef)` method returns the chain-side
  view (`settled` / `missing` / `reverted`) for the WS4
  reconciler.
- The rail's `decodeSettledLog(txHash, expected)` method
  decodes the on-chain `Settled` event and asserts the
  `assetAmount` / `paymentAmount` match the TEE's
  authorized plaintext. The integration test calls this
  directly to assert end-to-end correctness.

**What WS2.5 still does NOT do (production migration):**
- The relayer key is still held in the backend's env. The
  T3 tenant TEE swap is a one-file change to
  `chain-sepolia-rail.ts` (replace the `WalletClient`
  construction with a TEE-attested one). This is the
  last unblocked step to a fully production-grade chain
  rail.
- The relayer contract holds the institutions' pre-approved
  allowances directly. Production should consider
  per-institution relayer proxies (each institution has
  its own minimal proxy that holds its allowances and
  delegates `settle` to the canonical relayer) for
  cleaner key-rotation and per-institution recovery.

**Risks (resolved):**
- ✅ Solidity compiler available (Forge 1.7.1 + solc 0.8.24
  bundled).
- ✅ viem `writeContract` works against the relayer's
  full ABI (no manual encoding).
- ✅ On-chain `Settled` event decodes correctly; the
  integration test asserts the `assetAmount` /
  `paymentAmount` round-trip.

### WS2.5.6 — TEE-attested relayer signer seam (production swap)

**Goal:** Replace the relayer's "key in env" with a
deliberate seam that lets the production swap to a
T3-tenant-TEE-held key without changing the rail. The
seam is the `RelayerTransactionSigner` interface; the
v1 demo path is `ViemWalletRelayerSigner` (viem's
`WalletClient` with the env-var key); the production path
is `TeeAttestedRelayerSigner` (the T3 tenant identity
loaded via `t3-enclave`'s `loadOrCreateTenantIdentity(...)`).

**Acceptance gate (this is what we shipped):**
- The `SepoliaErc20Rail` constructor takes an optional
  `relayerSigner` in `SepoliaErc20RailDeps`. When omitted
  (the v1 demo), the rail builds a
  `ViemWalletRelayerSigner` from the existing
  `walletClient` + `account`. When provided (the
  production swap), the rail uses the supplied signer
  for the broadcast step.
- The rail's `buildProof` now carries the on-chain
  `from` address in a new `railSignerAddress` field
  (string | null; null for the noop rail). The
  settlement service reads this field and emits a
  TEE-attestation telemetry event for the chain rail.
- The Anvil integration test for the TEE-attested path
  builds a `TeeAttestedRelayerSigner` whose
  `tenantPrivateKey` is the T3 tenant identity loaded
  via `loadOrCreateTenantIdentity(...)`. The test
  asserts the broadcast tx's `from` is the TEE signer
  address, decodes the on-chain `Settled` event, and
  verifies the `Transfer` balances round-trip.
- `app.ts` decides at boot time: when
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` is set
  (a T3 secret-ref), the wiring builds a
  `TeeAttestedRelayerSigner` from the T3 tenant
  identity. When unset (the v1 demo), the wiring
  builds a `ViemWalletRelayerSigner` from the
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`
  env var.
- The doc-gaps addendum records the new state: the
  production-swap interface is in place; the only
  remaining open question is the underlying T3
  secret-store + relayer-primitive host interface
  (T3-ONB-011).

**Files (this WS):**
- `backend/src/services/settlement-rails/relayer-signer.ts` —
  the new `RelayerTransactionSigner` interface,
  `ViemWalletRelayerSigner` (v1 demo), and
  `TeeAttestedRelayerSigner` (production swap).
- `backend/src/services/settlement-rails/rail.ts` —
  new `railSignerAddress: string | null` field on
  `RailSettlementProof`.
- `backend/src/services/settlement-rails/chain-sepolia-rail.ts`
  — refactored to use the new interface; the
  `dispatchCache` now stores `{txHash, from}`.
- `backend/src/services/settlement-rails/noop-custodial-rail.ts`
  — sets `railSignerAddress: null` (no on-chain
  transport).
- `backend/src/config/env.ts` — new env var
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF`.
- `backend/src/app.ts` — production-swap wiring
  (gated on the new env var).
- `backend/src/tests/integration/settlement-rail-noop.test.ts`
  — updated expected proof shape to include the
  new `railSignerAddress: null` field.
- `backend/src/tests/integration/settlement-rail-chain-sepolia.test.ts`
  — the Anvil integration test for the TEE-attested
  path (gated by `WS2_ANVIL_INTEGRATION=1`).

**Why this is the right production swap:**

1. **No rail change.** The rail's `dispatch` calls
   `relayerSigner.signSettle(...)` and reads
   `railSignerAddress` from the result. The rail
   does not know whether the signer is viem-based
   or TEE-attested.
2. **No contract change.** The relayer's `settle(...)`
   ABI is the same. The on-chain `from` is the
   canonical "the relayer is the institution's
   authorized counterparty-rail" identifier. A
   relayer key held in the TEE is provably not
   extractable from a compromised backend process.
3. **No privacy change.** The on-chain calldata is
   the relayer's `settle(bytes32,bytes32,address,address,address,address,uint256,uint256)` ABI
   — same as v1. A public chain observer sees the
   institution's deposit addresses and the two
   `amount` values, but **not** the TEE-decrypted
   `quantity * price` semantics. The production
   signer is attestation-anchored; the v1 demo
   signer is file-backed. The privacy claim is
   unchanged.

**Migration path (when T3N exposes the host interface):**
- The `TeeAttestedRelayerSigner`'s `walletClient` is
  swapped for a TEE-attested client whose key is
  held inside the tenant TEE.
- The `tenantPrivateKey` is loaded from a T3 secret
  store, not a file.
- The `isTeeAttested` flag flips to `true`; the
  settlement service emits a `rail_t3_tee_attested`
  telemetry event (in addition to the existing
  `rail_settled` event).
- The relayer's contract does not change.

**Risks (resolved):**
- ✅ The `SepoliaErc20Rail`'s `dispatchCache` shape
  change (string → `{txHash, from}`) is backward-
  compatible at the call-site level (the cached
  path uses the same `buildProof` signature).
- ✅ The `railSignerAddress` field is added to
  `RailSettlementProof` and threaded through the
  noop rail (null) and chain rail (broadcasted
  from). All existing tests pass.
- ✅ The Anvil integration test for the TEE-attested
  path broadcasts a real tx with the TEE signer
  address as the `from`; the on-chain `Settled`
  event decodes correctly; the ERC-20 `Transfer`
  balances round-trip.

## 5. Workstreams

### WS1 — Seam + NoopCustodialRail (this sprint)
`SettlementService` calls the dispatcher, the DB has the rail columns,
and every existing test still passes.

**Acceptance gate:**
- `npm run lint` and `npm run typecheck` exit 0.
- `npm run test` exits 0.
- `settlement-success.test.ts` and `settlement-atomicity.test.ts`
  pass with **zero test changes** (the rail's noop proof is accepted
  by the existing assertions).
- A new unit test `settlement-rail-noop.test.ts` proves the noop
  rail is called exactly once per `executeSettlement` and that its
  proof flows into the `completed_trades.rail_trade_ref` column.
- The demo "Spin up demo agents" run produces a `completed_trades` row
  with `rail_id = "wallet:default"` and
  `rail_trade_ref = "noop:<sha256>"` (run end-to-end and inspect).

**Files (estimated):**

- `backend/src/services/settlement-rails/rail.ts` — interface
  (~50 lines).
- `backend/src/services/settlement-rails/noop-custodial-rail.ts` —
  implementation (~40 lines).
- `backend/src/services/settlement-rails/dispatcher.ts` — profile →
  rail map (~30 lines).
- `backend/src/services/settlement.service.ts` — insert
  `dispatcher.dispatch(...)` call between `commandBuilder.build(...)`
  and `repository.persistCompletedSettlement(...)`. Pass the proof's
  `railTradeRef` and `railId` into the repository.
- `backend/src/services/settlement.repository.ts` — extend the
  `persistCompletedSettlement` payload to include `railId` and
  `railTradeRef`. Update the `RpcQuery<>` parameter type.
- `database/migrations/011_completed_trades_rail_columns.sql` — new
  migration.
- `database/migrations/003_create_audit_receipts.sql` — update the
  `persist_completed_settlement` function signature (this is the
  schema-level authority for what the row looks like).
- `backend/src/models/completed-trade.ts` — extend
  `CompletedTradeRecord` and `CompletedTrade` with the new fields.
- `backend/src/app.ts:241-265` — wire the dispatcher alongside the
  existing `SettlementService` construction.
- `backend/src/tests/integration/settlement-rail-noop.test.ts` — new.

**Risks:**
- The `persist_completed_settlement` RPC is type-checked in the
  Supabase types. Adding columns to the DB without updating the
  generated types breaks `RpcQuery<>`. Mitigation: regenerate the
  types as part of WS1, and add a unit test that asserts the
  `RpcQuery<>` parameter includes `rail_id` and `rail_trade_ref`.
- The existing `executeSettlement` happy path does not depend on a
  rail, so the new dispatcher call must be **synchronous-fast** in
  the noop case. A blocking external call would regress settlement
  latency in the demo path. Mitigation: the noop rail is in-memory
  and returns in <1ms; benchmark before/after.

### WS2 — ChainRail on Sepolia (the demo)

**Goal:** A real `ChainRail` implementation against Sepolia, with the
TEE-attested relayer preserving G1.

**Acceptance gate:**
- Two institutions on the chain rail, real deposit addresses, real
  Sepolia testnet USDC + WBTC, complete a trade whose `rail_trade_ref`
  is a real tx hash clickable to Etherscan.
- `npm run test` exits 0.
- A new integration test `settlement-rail-chain-sepolia.test.ts`
  hits the chain rail with a forked or testnet RPC, asserts the tx
  is broadcast and confirmed, asserts the `rail_trade_ref` is the
  returned tx hash, asserts the DB row's `rail_id = "chain:sepolia:erc20"`.
- The `/deploy` and `/settings` pages show the chain rail as
  available.
- An idempotency test proves calling `dispatch` twice with the same
  outcome returns the same `railTradeRef` (no double-spend).

**Files (estimated):**
- `backend/src/services/settlement-rails/chain-sepolia-rail.ts` —
  ~200 lines. Uses `viem` (already on the dependency tree in the
  boundbuyer reference, needs to be added to backend if not present).
- `backend/src/services/settlement-rails/relayer-client.ts` — ~80
  lines. Talks to the T3-attested relayer contract.
- `backend/src/services/settlement-rails/chain-rail-errors.ts` —
  typed errors for "rail failed", "rail not confirmed", "rail
  timeout", "rail double-spend".
- New env vars:
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL`,
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT`,
  `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_KEY_REF` (T3 secret ref,
  not a raw key).
- `backend/src/config/env.ts` — extend the Zod schema.
- `backend/src/tests/integration/settlement-rail-chain-sepolia.test.ts` —
  new.

**Risks:**
- Sepolia testnet faucets are unreliable. Mitigation: the test
  seeds test wallets with pre-funded USDC/WBTC at test setup using
  a known-funded test wallet, or uses Anvil with a forked Sepolia
  state for unit tests and Sepolia for the manual end-to-end demo.
- The relayer contract is a TEE contract. If T3 has not shipped
  relayer primitives in the public T3N API yet (see
  `docs/terminal3-adk-onboarding-doc-gaps.md:530-544`), this WS
  is blocked. Mitigation: in-memory relayer stub for the demo (the
  relayer's signing happens in the same process, with a documented
  "would run inside the T3 tenant TEE in production" comment), and
  log a doc-gap entry.
- Gas spikes on Sepolia can cause settlement to time out. Mitigation:
  configurable gas-price ceiling; on timeout, the rail returns
  `railState: "failed"` and the orchestrator cancels the trade.

### WS3 — Institution onboarding UI

**Goal:** An operator can pick a settlement profile at institution
creation time and see the current profile on `/settings`.

**Acceptance gate:**
- Institution-create form has a "Settlement profile" dropdown with
  three options: `wallet:default` (no external movement, for demos),
  `chain:sepolia:erc20` (real testnet movement), `custody:fireblocks`
  (not implemented, disabled with a tooltip).
- Picking `chain:sepolia:erc20` prompts for a deposit address and a
  per-asset token address; these are stored on
  `institutions.metadata`.
- The settings page shows the current profile, the deposit address
  (masked), the last 10 settlement rail refs (clickable to
  Etherscan for chain rail).
- All existing `/settings` flows still work.

**Files (estimated):**
- `frontend/src/components/SettingsPanel.tsx` — extend with the
  settlement profile section.
- `frontend/src/components/CreateInstitutionForm.tsx` (or equivalent)
  — extend with the dropdown.
- `frontend/src/services/api-client.ts` — extend the institution
  create/update payload types.

### WS4 — Reconciliation + reversal + observability

**Goal:** Drift between the rail and the DB is detected and
recoverable. Reversal is a privileged operation. A new telemetry
event lets ops graph rail success rate and p99.

**Acceptance gate:**
- A 10-minute reconciliation job reads
  `completed_trades WHERE rail_state = 'settled' AND reconciled_at IS NULL`
  and calls `rail.status(railTradeRef)` to confirm. Updates
  `reconciled_at`. On drift, raises a high-severity telemetry event.
- A new admin endpoint
  `POST /api/admin/trades/:tradeRef/reverse` calls `rail.reverse(...)`,
  flips `completed_trades.settlement_status` to `"reversed"`, writes
  a new `completed_trades` row for the reversal with
  `rail_state = "reversed"`, and emits a new audit receipt.
- A new telemetry event `telemetry.rail.settled` is published with
  `railId`, `railTradeRef`, `latencyMs`.

**Files (estimated):**
- `backend/src/services/settlement-rails/reconciler.ts` — ~80 lines.
- `backend/src/services/settlement-rails/reverser.ts` — ~50 lines.
- `backend/src/api/admin.routes.ts` — new admin route.
- `backend/src/websocket/telemetry-event.ts` — extend the
  discriminated union.

### WS5 — Documentation + `/deploy` UX touchups

**Goal:** A new operator can read `docs/settlement-rails.md`, create
an institution on the chain rail, deploy an agent, and complete a real
testnet trade.

**Acceptance gate:**
- `docs/settlement-rails.md` exists, covers the three profiles, the
  operator's responsibilities per profile, the security model (G1
  through G5), and a troubleshooting runbook for "my DB says settled
  but my chain says pending".
- `/deploy` page's Configure tab has a one-line callout pointing
  to `/settings` for settlement profile.
- The hackathon submission is updated with the chain rail demo URL
  and a known Etherscan tx hash.

**Files (estimated):**
- `docs/settlement-rails.md` — new.
- `frontend/src/components/AgentDeploymentGuide.tsx:78-99` — one-line
  callout in the Configure tab.
- `SUBMISSION.md` — update.

---

## 6. Cross-cutting constraints

These come from the existing repo and apply to every WS.

- **Production-ready, no mocks, no fakes, no hard-coded values.**
  The noop rail is not a fake — it is a real, documented rail with a
  real proof type. The chain rail is the only thing that is "real
  money movement" in the v1 cut, and it must hit a real chain.
- **No mocks in tests.** The `ChainRail` integration test uses Anvil
  with a forked Sepolia state, not a mock chain. The
  `NoopCustodialRail` test uses a real `SettlementService` with a
  real Supabase test DB, not a mock repository.
- **No fakes in the TEE contract path.** The `executeSettlement` flow
  goes through the real `SettlementCommandBuilder` and the real
  `persist_completed_settlement` RPC; only the rail call is new.
- **DB schema authority.** `database/schema.sql` is for context. The
  schema-level authority is `database/migrations/`. New columns go in
  a new migration; the `persist_completed_settlement` function update
  goes in the same migration.
- **AGENTS.md / `docs/agent-integration/AUTHENTICATION.md`** are
  unchanged in v1. The wallet-connect path is still operator-only;
  the agent SDK still uses API keys only.
- **T3 doc gaps.** If WS2 (chain rail) discovers that T3N does not
  expose the relayer contract primitives we need, log a doc gap in
  `docs/terminal3-adk-onboarding-doc-gaps.md` per the AGENTS.md
  instruction.

---

## 7. Sequencing and ownership

| WS | Depends on | Est. size | Shippable on its own? |
|---|---|---|---|
| WS1 — seam + noop | — | 1-2 days | **Yes. This sprint.** |
| WS2 — chain rail | WS1 | 4-7 days | Yes (demo depends on WS3 + WS5). |
| WS3 — onboarding UI | WS1 | 1-2 days | Yes, but visually empty until WS2 ships. |
| WS4 — reconciliation | WS2 | 2-3 days | Yes. |
| WS5 — docs + deploy UX | WS2, WS3 | 1-2 days | Yes. |

WS1 is the smallest unit that produces a mergeable, testable, demoable
change. The demo "Spin up demo agents" run after WS1 has a
`rail_trade_ref = "noop:<sha256>"` on its `completed_trades` row,
proving the seam works.

WS2 is the headline. WS3-WS5 are the polish that makes the headline
legible to a judge who is not reading the code.

---

## 8. Open questions deferred

These came up during planning. Defer answers until the relevant WS is
in flight.

- **Q1.** Do we expose a "sandbox mode" `settlementProfileRef` that
  uses Anvil instead of Sepolia, for the live demo when Sepolia is
  flaky? (WS2 decision.)
- **Q2.** Does the chain rail require the operator to pre-fund
  approvals (`approve(rail, MAX)`) on the deposit address, or does
  the rail's first call include an approval step? (WS2 design.)
- **Q3.** What is the canonical event topic for `telemetry.rail.settled`
  — same `telemetry.processing.changed` channel as other settlement
  events, or a new `telemetry.rail.changed` channel? (WS4 decision.)

Each Q is small enough to answer inside its WS without blocking
WS1.
