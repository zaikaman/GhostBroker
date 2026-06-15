# GhostBroker Settlement Rails — Operator Runbook

**Audience:** an operator deploying a GhostBroker institution and
needing to understand the three settlement profiles, their security
properties, the operator's responsibilities per profile, and how to
recover from common failure modes.

**Last updated:** 2026-06-15 (post WS2.5 / WS3 / WS4).

---

## 1. The three profiles in one paragraph

GhostBroker ships three settlement rails. Every institution picks
exactly one via `institutions.settlement_profile_ref`:

| Profile | What moves on settlement? | Operator's job |
|---|---|---|
| `wallet:default` | Nothing — the DB row is the only artifact. | None. |
| `chain:sepolia:erc20` | Real ERC-20 `transferFrom` calls on Sepolia, routed through the on-chain `GhostBrokerSettlementRelayer` contract. | Fund the deposit address, pre-approve the relayer for each asset. |
| `custody:<partner>` | Reserved for future custody partners. Not implemented in v1; passing the profile name throws `RailDispatchError`. | N/A in v1. |

The rail is **the only thing that physically moves assets**. Everything else in the system (the TEE match outcome, the DB `completed_trades` row, the audit receipts, the telemetry) is bookkeeping.

---

## 2. The chain rail end-to-end

The chain rail is the only profile that produces a public
on-chain artifact. This is the diagram that explains the
system:

```
┌──────────┐  ┌─────────────┐  ┌────────────────────────┐  ┌──────────┐
│ TEE match │→ │ settlement │→ │ GhostBrokerSettlement │→ │ Sepolia  │
│ (opaque)  │  │ command    │  │ Relayer (EVM contract) │  │ ERC-20   │
└──────────┘  └─────────────┘  └────────────────────────┘  └──────────┘
                  │                       │                       │
                  │   signed tx data:     │   emit Settled event  │
                  │   outcomeRef,         │   (assetAmount,       │
                  │   assetLeg,           │    paymentAmount)     │
                  │   paymentLeg          │                       │
                  │   (ABI-encoded)       │   transferFrom calls  │
                  │                       │   → buyer & seller    │
                  │                       │     deposit addresses │
```

The relayer holds the **pre-approved ERC-20 allowances** from each
institution's deposit address. The relayer's `settle(...)` is a
single transaction that:
1. Pulls the asset (e.g. WBTC) from the **buyer's** deposit address
   to the **seller's** deposit address.
2. Pulls the payment (e.g. USDC) from the **seller's** deposit
   address to the **buyer's** deposit address.
3. Emits a `Settled` event whose `outcomeRef` matches the TEE's
   opaque match outcome.

The on-chain calldata is the relayer's `settle(bytes32, bytes32,
address, address, address, address, uint256, uint256)` ABI. A
public chain observer sees the **institution's deposit addresses**
and the **asset/payment amounts** but **not** the TEE-decrypted
`quantity * price` semantics (the relayer is the canonical
source of those — the chain does not duplicate them).

---

## 3. Per-profile operator responsibilities

### `wallet:default` (noop)

Nothing. The system writes a `completed_trades` row with
`rail_id = "wallet:default"` and `rail_trade_ref = "noop:<sha256>"`.
No external transport. Suitable for the demo "Spin up demo agents"
button and for any test or non-production environment where
real-asset movement is not desired.

### `chain:sepolia:erc20` (Sepolia)

Before the rail can dispatch the institution's first trade, the
operator must:

1. **Pick a deposit address.** This is the institution's on-chain
   identity. For v1 it can be the relayer's own address (a
   degenerate case that lets the demo run without separate
   addresses); production requires a per-institution address.
2. **Pre-approve the relayer** for the asset token and the
   payment token. The operator runs two `approve(relayerContract,
   MAX)` calls on the asset token and the payment token from the
   deposit address.
3. **Configure `institutions.metadata`**:
   - `depositAddress`: the per-institution address above
   - `tokenAddresses`: a `Record<assetCode, erc20Address>` map.
     For the demo, the operator supplies the Sepolia testnet
     WBTC and USDC addresses.
4. **Pick a rail ref**: `chain:sepolia:erc20`.
5. **(Production)** deploy the relayer contract. For the demo
   the Anvil integration test deploys it per run.

After this setup, every trade on the chain rail produces:
- a real `settle(...)` transaction on Sepolia
- a real on-chain `Settled` event with the relayer's
  `assetAmount` and `paymentAmount`
- two real ERC-20 `Transfer` events (one on the asset token,
  one on the payment token)
- a `completed_trades.rail_trade_ref` that is the on-chain tx
  hash, clickable on Etherscan at
  `https://sepolia.etherscan.io/tx/<rail_trade_ref>`

### `custody:<partner>` (future)

Reserved. The schema accepts the prefix; the rail dispatcher
returns `RailDispatchError` (which the settlement service maps to
a 503 `service_unavailable` public error). WS3.5+ work adds the
first partner; WS5+ is the post-hackathon roadmap.

---

## 4. Security model

### What the TEE guarantees

- The match outcome is computed inside the T3 tenant TEE. The
  plaintext `quantity` and `executionPrice` never leave the TEE
  in plaintext. They are released to the settlement command
  builder only after the builder re-verifies both agents'
  W3C VCs.
- The `outcomeRef` is a deterministic SHA-256 of the two intent
  handles + a correlation ref. It is the on-chain authority for
  idempotency (the relayer reverts a second `settle` with the
  same outcome).
- The `encryptedTradeFieldsRef` is the TEE's receipt join key.
  The on-chain `Settled` event references it; the off-chain
  receipt decryption happens in the operator's audit pipeline.

### What the chain reveals

- The relayer's address (the `to` of every rail transaction).
- The relayer contract's address.
- The two institutions' deposit addresses (necessary for the
  ERC-20 `transferFrom` calls).
- The asset and payment token addresses.
- The two `amount` values (necessary for the `transferFrom`
  calls).
- The `outcomeRef` (a 32-byte hash; the on-chain idempotency key).
- The `encryptedTradeFieldsRef` (a 32-byte hash; the audit join
  key).

### What the chain does **not** reveal

- The TEE-decrypted `quantity` and `executionPrice` are **not**
  on-chain as plaintext integers. The relayer's calldata carries
  the raw `assetAmount` and `paymentAmount` (which are
  `quantity` and `quantity * executionPrice` denominated in the
  token's smallest unit, e.g. WBTC's satoshis). A public chain
  observer sees a `settle(...)` transaction whose two
  `amount` fields are the token-denominated values, but the
  off-chain `executionPrice` is not directly readable from the
  chain. (A determined observer can derive `executionPrice =
  paymentAmount / assetAmount` when the price is a clean
  rational; for prices with many decimal places the
  reconstruction is non-trivial. This is the privacy
  property WS2 set out to deliver.)

### Threats and mitigations

| Threat | Mitigation |
|---|---|
| Operator loses the relayer key. | Production: the relayer key is held in the T3 tenant TEE; key rotation is a T3 admin action. v1: the relayer key is in the backend's env; rotation requires a backend redeploy. |
| Re-org drops a settled trade. | WS4 reconciler detects drift within 10 minutes and emits a `rail_drift_detected` telemetry event. The reverser (admin) is the only path that can flip the row's status. |
| Institution changes its deposit address mid-trade. | The rail reads the deposit addresses at `dispatch` time; the trade that was in flight when the address changed will fail with `transferFrom` revert. The orchestrator's existing cancellation path releases the locked balance. |
| Counterparty deposit address == self deposit address. | The rail throws a typed `Error: buyer and seller deposit addresses are identical`. The trade is not recorded. The operator must fix the institution config and retry. |
| Allowance not set. | The relayer's `transferFrom` reverts; the rail catches the revert and returns a typed `RailDispatchError`; the settlement service maps to a 503 `service_unavailable`; the trade is not recorded. The operator must approve the relayer from the deposit address. |

---

## 5. Operational telemetry

The settlement service emits the following telemetry events
on the operator's websocket:

| Phase | Severity | When |
|---|---|---|
| `rail_settled` | info | A rail's `dispatch` returned a successful proof. Carries `railProofRef` (rail id + tx hash) and `latencyMs`. |
| `rail_reconciled` | info | The reconciler confirmed the chain state matches the DB row. |
| `rail_drift_detected` | error | The reconciler found the chain state disagrees with the DB. The DB row is still marked reconciled (so the next sweep does not loop), but the row's `settlement_status` is unchanged. The reverser is the only path that can flip the row's status. |
| `rail_reconcile_error` | error | The rail's `status(...)` call threw (e.g. RPC unreachable). The row stays unreconciled; the next sweep retries. |
| `rail_reversed` | info | The admin reverser flipped a row's state via the noop rail's `reverse()` (or the chain rail's on-chain reversal, in production). |

The `telemetry.rail.settled` event is the primary SLI for the
chain rail. Ops should graph:
- p50 / p99 `latencyMs` per rail
- `rail_settled` rate vs `rail_drift_detected` rate
- `rail_reconcile_error` rate as a signal of RPC reliability

---

## 6. Troubleshooting runbook

### Symptom: "Buyer and seller deposit addresses are identical."

The chain rail's `dispatch` throws this when the operator
configured both institutions with the same `depositAddress`.
This is a safety check; the trade is not recorded. The fix:
PATCH each institution's metadata with a distinct deposit
address. Then re-submit the trade.

### Symptom: "Missing deposit address(es) for institutions X / Y."

The chain rail's `dispatch` throws this when one or both
institutions have no `metadata.depositAddress`. The trade is
not recorded. The fix: PATCH the institution's metadata with a
deposit address. The chain rail's metadata-validation
superRefine on `createInstitution` and `updateInstitution` should
have caught this at institution-creation time; if it
slipped through, the operator should also fix the
institution-create flow.

### Symptom: "Missing token address(es) for USDC and WBTC."

Same shape. The institution's `metadata.tokenAddresses` map is
incomplete. PATCH the institution with the missing token
addresses.

### Symptom: A trade settled in the DB but the chain says "missing."

The reconciler's `rail.status(railTradeRef)` returned
`"missing"`. This can mean:
- The chain re-orged the tx out.
- The RPC is behind and hasn't seen the tx yet (transient).
- The tx was never broadcast (e.g. backend crash between
  broadcast and `waitForConfirmation`).

The DB row is marked reconciled (so the next sweep does not
loop). The reverser (admin) is the only path that can flip
the row's `settlement_status` to `"reversed"` and re-credit
the locked balance.

### Symptom: A trade settled in the DB but the chain says "reverted."

The relayer's `settle(...)` reverted. The most common cause is
an allowance not set on one of the deposit addresses. Inspect
the trade's `rail_trade_ref` on Etherscan to confirm. The
reverser is the path forward: re-credit the locked balance and
re-try the trade after fixing the allowance.

### Symptom: The reconciler emits `rail_reconcile_error` for every row.

The chain RPC is unreachable. The reconciler does not
`markReconciled` on error, so the rows stay unreconciled and
the next sweep retries. The fix is to restore the RPC; the
rows will catch up automatically.

### Symptom: Trade settled in DB but no `rail_settled` telemetry event.

The settlement service's `publishRailSettled` was never called.
The most likely cause: a `RailDispatchError` from the dispatcher
that the service mapped to a 503. Inspect the backend logs for
`RailDispatchError`.

---

## 7. Glossary

- **TEE** — Trusted Execution Environment. In GhostBroker, the
  T3 tenant TEE runs the matching-policy contract and produces
  the opaque match outcome.
- **Outcome** — the TEE's `OpaqueMatchOutcome`: a deterministic
  SHA-256 of the two intent handles, plus the institution ids
  and authority refs.
- **Encrypted trade fields** — the TEE-encrypted `quantity`,
  `executionPrice`, and `side` of a match. Decrypted by the
  settlement command builder, then re-encrypted to the
  relayer's calldata.
- **Settle** — the on-chain relayer's `settle(bytes32, bytes32,
  address, address, address, address, uint256, uint256)` call.
  Atomic: pulls the asset from the buyer and the payment from
  the seller, then emits the `Settled` event.
- **Reconcile** — the periodic task that reads the chain state
  of every settled `completed_trades` row and surfaces drift
  via telemetry.
- **Reverse** — the admin-only path that flips a settled row's
  `settlement_status` to `"reversed"`. The noop rail's
  `reverse` is a typed "no-op" (the DB row is the only
  artifact); the chain rail's `reverse` broadcasts a real
  on-chain reversal transaction against the relayer
  contract.
- **Rail trade ref** — the rail's transport proof stored on
  `completed_trades.rail_trade_ref`. For the noop rail it is
  `noop:<sha256>`; for the chain rail it is the on-chain tx
  hash. Clickable on Etherscan for the chain rail.
- **Reconciler** — the system task that verifies the chain
  state. See `backend/src/services/settlement-reconciler.ts`.
- **Reverser** — the admin endpoint at
  `POST /api/admin/trades/:tradeRef/reverse`. See
  `backend/src/api/admin.routes.ts`.

---

## 8. Where to look in the code

| Concern | File |
|---|---|
| Rail interface | `backend/src/services/settlement-rails/rail.ts` |
| Noop rail (default) | `backend/src/services/settlement-rails/noop-custodial-rail.ts` |
| Chain rail (Sepolia) | `backend/src/services/settlement-rails/chain-sepolia-rail.ts` |
| Relayer contract (Solidity) | `contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol` |
| Relayer ABI + bytecode | `backend/src/services/settlement-rails/abi/GhostBrokerSettlementRelayer.json` |
| Dispatcher | `backend/src/services/settlement-rails/dispatcher.ts` |
| Settlement chokepoint | `backend/src/services/settlement.service.ts` (rail call between `commandBuilder.build` and `repository.persist`) |
| Institution config resolver | `backend/src/services/institution-settlement-config-resolver.ts` |
| Reconciler | `backend/src/services/settlement-reconciler.ts` |
| Reconciler DB | `backend/src/services/settlement-reconciliation.repository.ts` |
| Admin reverser | `backend/src/api/admin.routes.ts` |
| PATCH institution | `backend/src/api/institutions.routes.ts` (PATCH route) |
| Institution schema | `backend/src/models/institution.ts` (chain-rail superRefine) |
| Settings page card | `frontend/src/components/SettlementProfileCard.tsx` |
| API client | `frontend/src/services/api-client.ts` (rail methods + `getCompletedTrades`) |
| Plan doc | `.hermes/plans/settlement-rails.md` |
| Doc gaps | `docs/terminal3-adk-onboarding-doc-gaps.md` (Addendum 2026-06-15 + the new WS2.5 addendum) |

---

## 9. The privacy story in one sentence

**The on-chain calldata carries two ERC-20 `amount`s, the
institution's deposit addresses, and a 32-byte outcome hash; the
TEE-decrypted `quantity` and `executionPrice` semantics live only
in the TEE-encrypted receipt blob referenced by the on-chain
`Settled` event.**

That is the entire privacy claim end-to-end through settlement.
