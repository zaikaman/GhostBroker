import { randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface MatchEvaluationRequest {
  buyIntentHandle: string;
  sellIntentHandle: string;
  correlationRef: string;
  /**
   * Shared traded asset code (e.g. `"WBTC"`). Both sides must
   * trade the same instrument; the orchestrator already
   * filters this locally, but the enclave re-checks it so a
   * cross-asset fill is a `no_match`, not a silent error.
   */
  assetCode: string;
  /**
   * Buy-side bid price, decimal string at the contract's
   * implicit `WIRE_SCALE` (1e18). JSON numbers may be
   * IEEE-754 doubles on some hosts; rounding them would
   * make the midpoint non-deterministic, so the wire form
   * is always a plain decimal string the contract parses
   * into an exact scaled `u128` internally. Sourced from the
   * TEE-attested `T3LockDescriptor.price` returned by
   * `seal-intent` v0.8.0+ — the envelope is unsealed inside
   * the enclave and the orchestrator carries the value
   * through without re-decoding.
   */
  buyPrice: string;
  /**
   * Buy-side intent quantity, same `WIRE_SCALE` decimal
   * string. Sourced from the TEE-attested
   * `T3LockDescriptor.quantity`.
   */
  buyQuantity: string;
  /**
   * Sell-side ask price, same `WIRE_SCALE` decimal string.
   * Sourced from the TEE-attested
   * `T3LockDescriptor.price`.
   */
  sellPrice: string;
  /**
   * Sell-side intent quantity, same `WIRE_SCALE` decimal
   * string. Sourced from the TEE-attested
   * `T3LockDescriptor.quantity`.
   */
  sellQuantity: string;
  /**
   * The buyer institution UUID the orchestrator already holds
   * in its pending-intent queue (the value the seal call
   * accepted at submit time on the buy side). Required as of
   * v0.8.0 so the TEE can echo it back on the match outcome —
   * the audit trail carries the TEE-attested value instead of
   * an orchestrator-stamped override. The orchestrator asserts
   * the echo matches the queue value and fails closed on
   * mismatch.
   */
  buyInstitutionId: string;
  /**
   * The seller institution UUID the orchestrator already holds
   * in its pending-intent queue. Required as of v0.8.0; see
   * `buyInstitutionId` for the rationale.
   */
  sellInstitutionId: string;
  /**
   * The buy-side authority ref (the Ghostbroker delegation VC
   * reference the buy agent presented at submit time). Required
   * as of v0.8.0; the TEE echoes it back on the match outcome
   * and binds it to `matchAttestationRef` for the audit trail.
   */
  buyAuthorityRef: string;
  /**
   * The sell-side authority ref. Required as of v0.8.0; see
   * `buyAuthorityRef` for the rationale.
   */
  sellAuthorityRef: string;
}

export interface OpaqueMatchOutcome {
  outcomeRef: string;
  executionRef: string;
  /**
   * TEE-echoed buyer institution UUID (v0.8.0+). The audit
   * trail carries this value as the buyer for the outcome —
   * not the orchestrator's in-memory queue value. The
   * orchestrator asserts the echo matches the queue value it
   * submitted before settling.
   */
  buyerInstitutionId: string;
  /**
   * TEE-echoed seller institution UUID (v0.8.0+). See
   * `buyerInstitutionId` for the rationale.
   */
  sellerInstitutionId: string;
  encryptedTradeFieldsRef: string;
  /**
   * TEE-echoed buyer authority ref (v0.8.0+). The settlement
   * record stores this ref alongside the institution IDs so an
   * auditor can verify the buy-side authority bound to the
   * outcome matches the buy-side authority on the VC the agent
   * presented at submit time.
   */
  buyerAuthorityRef: string;
  /**
   * TEE-echoed seller authority ref (v0.8.0+). See
   * `buyerAuthorityRef` for the rationale.
   */
  sellerAuthorityRef: string;
  /**
   * TEE-attested match attestation ref (v0.8.0+). Deterministic
   * SHA-256 over the canonical concatenation of (buy handle,
   * buyer institution ID, sell handle, seller institution ID,
   * buy authority ref, sell authority ref, correlation ref,
   * asset code, outcome ref, execution ref). The settlement
   * record stores this ref so a judge reading the
   * `completed_trades` row can re-derive the attestation from
   * the recorded fields and confirm the institution IDs in the
   * row are the IDs the TEE bound to the match outcome.
   */
  matchAttestationRef: string;
  expiresAt: string;
  status: "matched" | "no_match";
  /**
   * Authoritative fill quantity decided by the enclave
   * (`min(buy_quantity, sell_quantity)` on a cross). A positive
   * number when `status === "matched"`; `0` on `no_match`. The
   * backend uses this for settlement and never recomputes it.
   */
  matchedQuantity: number;
  /**
   * Authoritative execution price decided by the enclave
   * (deterministic midpoint of the bid/ask). A positive number
   * when `status === "matched"`; `0` on `no_match`. The backend
   * uses this for settlement and never recomputes it.
   */
  executionPrice: number;
  /**
   * TEE-attested per-side lock release amounts. The TEE is the
   * sole authority on the original reservation (the seal call
   * computed `quantity * bidPrice` for the buy side and
   * `quantity` for the sell side); the matched portion of
   * those reservations is `buyer_locked_amount` /
   * `seller_locked_amount` here. The settlement service
   * consumes these to release exactly the matched portion of
   * each side's `portfolios.locked` row without the
   * orchestrator needing to recompute the math.
   */
  buyerLockedAmount: number;
  sellerLockedAmount: number;
}

export interface MatchContractClient {
  evaluateMatch(request: MatchEvaluationRequest): Promise<OpaqueMatchOutcome>;
}

export interface T3MatchContractClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
  /**
   * Explicit matching contract version to request from T3N.
   * Defaults to `"0.4.0"` — the fractional-decimal wire form
   * (`"0.0001"` for quantities, `"70000"` for prices) is
   * required for sub-unit fills; the older `0.2.0` / `0.3.0`
   * builds only accepted integer decimal strings and returned
   * `no_match` on anything below 1. The T3N adapter
   * (`readVersionFromBody`) reads this off the request body so
   * the tenant routes to the right published version.
   */
  contractVersion?: string;
}

interface T3MatchOutcomeResponse {
  outcome_ref?: string;
  execution_ref?: string;
  buyer_institution_id?: string;
  seller_institution_id?: string;
  encrypted_trade_fields_ref?: string;
  buyer_authority_ref?: string;
  seller_authority_ref?: string;
  match_attestation_ref?: string;
  expires_at?: string;
  status?: "matched" | "no_match";
  matched_quantity?: string;
  execution_price?: string;
  buyer_locked_amount?: string;
  seller_locked_amount?: string;
}

/**
 * Wire shape version for the T3 `evaluate-match` contract. The
 * T3N adapter (`readVersionFromBody`) reads this off the request
 * body and routes execution to the matching published version:
 *
 *   - `0.4.0` — first fractional-decimal wire form (`"0.0001"`
 *     quantities, `"70000"` prices). Required for sub-unit
 *     fills; older `0.2.0` / `0.3.0` builds only accept integer
 *     decimals and silently return `no_match` on anything
 *     below 1. This version consumed plaintext `assetCode`,
 *     `buyPrice`, `buyQuantity`, `sellPrice`, `sellQuantity` on
 *     the wire.
 *
 * `evaluate-match` v0.9.0+ also routes the per-round
 * negotiation crosses through two new exports —
 * `seal-round-proposal` and `evaluate-round`. See
 * `enclave/negotiation/round-client.ts` for the wire shape
 * and `enclave/contract-version.ts` for the single source of
 * truth on the version constant.
 */
import { DEFAULT_CONTRACT_VERSION } from "../contract-version.js";

function requireOpaque(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`T3 match response missing ${field}.`);
  }

  return value;
}

/**
 * Parse a decimal-string fill field returned by the enclave into a
 * finite, non-negative number. Accepts plain integers (`"4"`,
 * `"50000"`) and fractional decimals (`"0.0001"`) — the v0.4.0
 * contract emits the same human-readable decimal form it accepts
 * on the wire. Rejects scientific notation, signs, empty strings,
 * whitespace, and any non-numeric byte. Returns `undefined` when
 * the field is malformed; the caller treats that as a malformed
 * matched response and rejects it.
 */
function parseFillNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Plain non-negative decimal: digits, with at most one `.`
  // separator and at least one digit on each side. Rejects
  // `+`, `-`, exponents, underscores, leading/trailing `.`,
  // and embedded whitespace — anything that would silently
  // round through `Number(...)` to a wrong value.
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed) && !/^\.\d+$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export class T3MatchContractClient implements MatchContractClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;
  private readonly contractVersion: string;

  public constructor(options: T3MatchContractClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/matching/evaluate";
    this.contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;
  }

  public async evaluateMatch(
    request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3MatchOutcomeResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        // The T3N adapter (`readVersionFromBody` in
        // `t3n-client.ts`) reads the sibling `version` field and
        // routes the execution to that published contract
        // version; `extractContractInput` strips it before the
        // body reaches the enclave. Pinning it here means a new
        // publish no longer depends on the tenant's default.
        version: this.contractVersion,
        // The TEE contract's `EvaluateMatchInput` deserializer
        // (contracts/matching-policy/src/lib.rs) expects
        // snake_case keys. The public `MatchEvaluationRequest`
        // is camelCase to match the rest of the GhostBroker API
        // surface, so we translate at the network boundary.
        //
        // The wire form is the v0.8.0 Rust canonical shape:
        // plaintext `asset_code`, `buy_price`, `buy_quantity`,
        // `sell_price`, `sell_quantity` (decimal strings at the
        // contract's implicit `WIRE_SCALE`), plus the per-side
        // identity fields the audit trail needs to attribute the
        // outcome. The orchestrator sources `buy_price` /
        // `buy_quantity` from the TEE-attested
        // `T3LockDescriptor` returned by `seal-intent` v0.8.0+;
        // the envelope was unsealed inside the TEE on the seal
        // path and the orchestrator carries the values through
        // without re-decoding.
        buy_intent_handle: request.buyIntentHandle,
        sell_intent_handle: request.sellIntentHandle,
        correlation_ref: request.correlationRef,
        asset_code: request.assetCode,
        buy_price: request.buyPrice,
        buy_quantity: request.buyQuantity,
        sell_price: request.sellPrice,
        sell_quantity: request.sellQuantity,
        // v0.8.0: per-side identity. The TEE echoes these back
        // on the match outcome and binds them to
        // `match_attestation_ref`. Required fields — the
        // orchestrator's pending-intent queue already holds
        // them (verified at seal time) and failing the call
        // would be a data-integrity bug at the orchestrator.
        buy_institution_id: request.buyInstitutionId,
        sell_institution_id: request.sellInstitutionId,
        buy_authority_ref: request.buyAuthorityRef,
        sell_authority_ref: request.sellAuthorityRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 match evaluation failed.");
    }

    const status = response.body.status ?? "matched";

    // Fill fields are authoritative on a `matched` outcome: the
    // enclave decided the cross, the quantity, and the price, and
    // the backend settles on those exact values. A `matched`
    // response missing either fill field, or carrying a
    // non-positive fill, is malformed and must not be trusted for
    // settlement — reject it rather than falling back to a local
    // recomputation (which would silently re-centralize match
    // authority back in the backend).
    let matchedQuantity = 0;
    let executionPrice = 0;
    let buyerLockedAmount = 0;
    let sellerLockedAmount = 0;
    if (status === "matched") {
      const q = parseFillNumber(response.body.matched_quantity);
      const p = parseFillNumber(response.body.execution_price);
      if (q === undefined || q <= 0) {
        throw new Error(
          "T3 match response missing or non-positive matched_quantity on matched outcome.",
        );
      }
      if (p === undefined || p <= 0) {
        throw new Error(
          "T3 match response missing or non-positive execution_price on matched outcome.",
        );
      }
      const buyerLockedRaw = parseFillNumber(response.body.buyer_locked_amount);
      const sellerLockedRaw = parseFillNumber(
        response.body.seller_locked_amount,
      );
      if (buyerLockedRaw === undefined || buyerLockedRaw <= 0) {
        throw new Error(
          "T3 match response missing or non-positive buyer_locked_amount on matched outcome.",
        );
      }
      if (sellerLockedRaw === undefined || sellerLockedRaw <= 0) {
        throw new Error(
          "T3 match response missing or non-positive seller_locked_amount on matched outcome.",
        );
      }
      matchedQuantity = q;
      executionPrice = p;
      buyerLockedAmount = buyerLockedRaw;
      sellerLockedAmount = sellerLockedRaw;
    }

    return {
      outcomeRef: requireOpaque(response.body.outcome_ref, "outcome_ref"),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      // v0.8.0: the TEE echoes the per-side identity back on
      // every outcome. We still accept an empty string for
      // backwards compatibility with pre-0.8.0 hosts — the
      // orchestrator's pending-intent queue stamping is the
      // legacy fallback and the audit story is no worse than
      // v0.6.0 in that case. New hosts always echo.
      buyerInstitutionId: response.body.buyer_institution_id ?? "",
      sellerInstitutionId: response.body.seller_institution_id ?? "",
      encryptedTradeFieldsRef: requireOpaque(
        response.body.encrypted_trade_fields_ref,
        "encrypted_trade_fields_ref",
      ),
      buyerAuthorityRef: response.body.buyer_authority_ref ?? "",
      sellerAuthorityRef: response.body.seller_authority_ref ?? "",
      // v0.8.0: TEE-attested match attestation. Required for
      // settlement records going forward; a missing value falls
      // back to an empty string so a pre-0.8.0 host doesn't
      // crash the orchestrator. The settlement record builder
      // surfaces the empty string to the audit log so a
      // downgrade is visible.
      matchAttestationRef: response.body.match_attestation_ref ?? "",
      expiresAt: requireOpaque(response.body.expires_at, "expires_at"),
      status,
      matchedQuantity,
      executionPrice,
      buyerLockedAmount,
      sellerLockedAmount,
    };
  }
}
