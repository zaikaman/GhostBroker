import { randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface MatchEvaluationRequest {
  buyIntentHandle: string;
  sellIntentHandle: string;
  correlationRef: string;
  /**
   * Sealed envelope for the buy-side intent. The T3 enclave
   * holds the only decryption key and extracts `assetCode`,
   * `side`, `quantity`, and `bidPrice` from it. Production
   * `evaluate-match` v0.5.0+ consumes envelopes instead of
   * plaintext trading parameters, so the orchestrator never
   * holds plaintext outside the TEE.
   */
  buyEnvelope: string;
  /**
   * Sealed envelope for the sell-side intent.
   */
  sellEnvelope: string;
  /**
   * TEE-issued attestation reference for the buy-side lock
   * descriptor. The enclave uses this to confirm the
   * orchestrator is forwarding the lock claim the seal call
   * actually produced for the buy intent handle.
   */
  buyLockAttestationRef: string;
  /**
   * TEE-issued attestation reference for the sell-side lock
   * descriptor.
   */
  sellLockAttestationRef: string;
}

export interface OpaqueMatchOutcome {
  outcomeRef: string;
  executionRef: string;
  buyerInstitutionId: string;
  sellerInstitutionId: string;
  encryptedTradeFieldsRef: string;
  buyerAuthorityRef: string;
  sellerAuthorityRef: string;
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
 *   - `0.5.0` — privacy boundary. Consumes sealed envelopes
 *     (`buy_envelope`, `sell_envelope`) plus the TEE-attested
 *     lock descriptor attestation references
 *     (`buy_lock_attestation_ref`, `sell_lock_attestation_ref`)
 *     and never requires plaintext price / quantity inputs
 *     from the orchestrator. The TEE holds the only
 *     decryption key for the envelopes and is the sole
 *     authority on the per-side reservation math.
 *
 * `0.5.0` is the production default. The T3N testnet may still
 * serve `0.4.0` for legacy tenants; the
 * `T3_MATCHING_CONTRACT_VERSION` env var lets operators pin to
 * a specific published version.
 */
const DEFAULT_MATCHING_CONTRACT_VERSION = "0.5.0";

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
    this.contractVersion =
      options.contractVersion ?? DEFAULT_MATCHING_CONTRACT_VERSION;
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
        // v0.5.0+ of the contract accepts sealed envelopes
        // (the TEE holds the only decryption key) plus the
        // TEE-attested lock descriptor attestation references;
        // it no longer requires plaintext price / quantity
        // inputs from the orchestrator.
        buy_intent_handle: request.buyIntentHandle,
        sell_intent_handle: request.sellIntentHandle,
        correlation_ref: request.correlationRef,
        buy_envelope: request.buyEnvelope,
        sell_envelope: request.sellEnvelope,
        buy_lock_attestation_ref: request.buyLockAttestationRef,
        sell_lock_attestation_ref: request.sellLockAttestationRef,
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
      // The TEE match contract intentionally returns empty strings
      // for the buyer/seller institution ids and authority refs:
      // it does not have that context inside the enclave. The
      // orchestrator already verified both agents and stamps the
      // actual values from its pending-intent queue before
      // settlement. Requiring these to be non-empty here would make
      // every real T3-backed match evaluation fail.
      buyerInstitutionId: response.body.buyer_institution_id ?? "",
      sellerInstitutionId: response.body.seller_institution_id ?? "",
      encryptedTradeFieldsRef: requireOpaque(
        response.body.encrypted_trade_fields_ref,
        "encrypted_trade_fields_ref",
      ),
      buyerAuthorityRef: response.body.buyer_authority_ref ?? "",
      sellerAuthorityRef: response.body.seller_authority_ref ?? "",
      expiresAt: requireOpaque(response.body.expires_at, "expires_at"),
      status,
      matchedQuantity,
      executionPrice,
      buyerLockedAmount,
      sellerLockedAmount,
    };
  }
}
