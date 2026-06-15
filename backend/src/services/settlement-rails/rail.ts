import type { SettlementCommand } from "@ghostbroker/t3-enclave";

/**
 * The settlement rail is the off-TEE transport that actually moves
 * assets when a match settles. WS1 of the settlement-rails workstream
 * (see `.hermes/plans/settlement-rails.md`) introduces this interface
 * and a `NoopCustodialRail` default; later workstreams add
 * `ChainRail` (Sepolia ERC-20) and a `CustodialRail` (Fireblocks-style
 * partner integration).
 *
 * The rail is invoked from `SettlementService.executeSettlement`
 * between the TEE `SettlementCommandBuilder.build(...)` call and the
 * `persistCompletedSettlement(...)` DB call. On success the proof is
 * stored alongside the `completed_trades` row; on failure no DB
 * write happens, the trade is not recorded, and the orchestrator's
 * existing cancellation path releases the locked balance.
 */
export interface SettlementRail {
  /**
   * Identifier matching `institution.settlement_profile_ref`. The
   * dispatcher in `dispatcher.ts` routes by this string.
   */
  readonly id: string;

  /**
   * Move the assets for a confirmed match and return a transport
   * proof. The proof is persisted alongside the `completed_trades`
   * row by the settlement service.
   *
   * MUST be idempotent. Given the same `command.outcomeRef` and
   * the same plaintext trade fields, a second call must return a
   * proof equivalent to the first (or, for the chain rail, return
   * the prior tx hash if it has been confirmed). This is what lets
   * the orchestrator safely retry settlement on transient errors.
   *
   * The optional `context` carries per-rail configuration that the
   * settlement service looks up at dispatch time: per-institution
   * deposit addresses, per-asset token addresses, the relayer
   * contract address, and similar. The interface leaves the shape
   * open so each rail declares what it needs; the noop rail reads
   * none of it.
   */
  dispatch(
    command: SettlementCommand,
    plaintext: SettlementRailPlaintext,
    context?: SettlementRailContext,
  ): Promise<RailSettlementProof>;

  /**
   * Best-effort reversal of a previously-settled trade. Reserved
   * for the admin reverser in WS4. The default noop rail returns a
   * "not_supported" state — only rails with a real transport can
   * reverse.
   */
  reverse(
    tradeRef: string,
    reason: string,
  ): Promise<RailSettlementProof>;
}

/**
 * The plaintext trade fields the TEE authorized for the match.
 * These are the same fields `SettlementExecutionRequest` already
 * carries (`assetCode`, `quantity`, `executionPrice`). Defined as
 * a separate interface so the rail interface does not depend on
 * the service-layer `SettlementExecutionRequest` type.
 */
export interface SettlementRailPlaintext {
  assetCode: string;
  quantity: number;
  executionPrice: number;
}

/**
 * Optional per-rail dispatch context. The settlement service
 * constructs this from per-institution config (looked up from
 * `institutions.metadata`) and from the orchestrator's
 * `SettlementExecutionRequest`. Rails that do not need context
 * (the noop rail) ignore it.
 *
 * The interface is intentionally open: each rail reads the
 * fields it needs and ignores the rest. This keeps the rail
 * interface decoupled from the institution model and from the
 * settlement service's internals.
 */
export interface SettlementRailContext {
  /** Per-institution deposit addresses, keyed by institutionId. */
  depositAddresses?: Readonly<Record<string, string>>;
  /**
   * Per-asset token addresses on the chain the rail writes to.
   * Keyed by asset code (e.g. `WBTC`, `USDC`).
   */
  tokenAddresses?: Readonly<Record<string, string>>;
  /**
   * The chain-specific relayer contract address. The rail
   * broadcasts transactions to this contract, which is the
   * party that holds pre-approved allowances from each
   * institution's deposit address.
   */
  relayerContractAddress?: string;
  /**
   * WS2: per-side settlement profile. Allows rails to know
   * which side of the match is on which rail, in case
   * asymmetric routing is supported in a future WS. For WS2
   * the orchestrator ensures both sides are on the same
   * profile before dispatching the chain rail.
   */
  buyerProfileRef?: string;
  sellerProfileRef?: string;
}

/**
 * The transport proof a rail returns. Stored on `completed_trades`
 * as `rail_id` + `rail_trade_ref` + `rail_state`. The full proof
 * (including asset movements) is held by the settlement service for
 * the duration of the persist call but not logged in plaintext —
 * see `SettlementService.executeSettlement` for the
 * confidentiality guard.
 */
export interface RailSettlementProof {
  /** The `id` of the rail that produced this proof. */
  railId: string;

  /**
   * Rail-specific transport identifier. For `NoopCustodialRail` this
   * is a deterministic sha256 of the outcome ref. For a chain rail
   * this is the on-chain tx hash. For a custody rail this is the
   * custodian's internal transfer ref.
   */
  railTradeRef: string;

  /**
   * WS2.5: the on-chain `from` address of the broadcast
   * transaction (the relayer's signer address). For the
   * `SepoliaErc20Rail` this is the T3 tenant identity's
   * address (v1 demo) or a T3-tenant-TEE-held key's
   * address (production). For the `NoopCustodialRail`
   * this is `null` (no on-chain transport).
   *
   * Surfaced in the proof so the settlement service
   * can emit the `rail_t3_tee_attested` or
   * `rail_t3_doc_gap_warning` telemetry event with the
   * right signer address for the operator's dashboard.
   */
  railSignerAddress: string | null;

  /** Final observed state. */
  railState: "settled" | "failed" | "reversed";

  /**
   * The asset movements the rail executed. Empty for the noop rail
   * (no external transport). For a chain rail, one entry per
   * on-chain transfer the relayer broadcast (typically two: payment
   * leg + asset leg, but ERC-20 batching may combine them).
   *
   * Quantity is a string to preserve precision at the rail
   * boundary — the rail layer may be talking to a chain that
   * expects wei-style integers, and `number` is not safe above 2^53.
   */
  assetMovements: readonly RailAssetMovement[];

  /** ISO-8601 timestamp of the rail's last state change. */
  observedAt: string;

  /**
   * Rail-specific raw payload (tx receipt, custody ref object).
   * Never logged in plaintext; held only in memory for the
   * duration of the persist call. Not persisted.
   */
  raw?: unknown;
}

export interface RailAssetMovement {
  assetCode: string;
  fromInstitutionId: string;
  toInstitutionId: string;
  /** String-encoded integer; preserves precision at the rail boundary. */
  quantity: string;
  /**
   * Rail-native identifier for the asset (ERC-20 token address,
   * custody account id, etc). May be the empty string for rails
   * that do not reference a per-asset rail id.
   */
  railAssetRef: string;
}
