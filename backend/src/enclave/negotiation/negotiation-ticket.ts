import { createHash, randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface NegotiationTicketRequest {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  policyHash: string;
  compatibilityToken: string;
  correlationRef: string;
}

export interface NegotiationTicketResult {
  ticketHandle: string;
  executionRef: string;
  sealedAt: string;
  state: "ticket_sealed";
}

/**
 * Pair attestation: the TEE is the structural authority on
 * whether a candidate pair of sealed negotiation tickets is
 * matchable. The orchestrator must call this BEFORE creating a
 * session; the TEE returns `status: "compatible"` only when
 * every structural axis (handle well-formedness, asset
 * agreement, opposite side, different institution) agrees.
 *
 * On `incompatible`, `reason_code` is a stable machine-readable
 * code from the WIT world comment and `reason` is a
 * human-readable explanation suitable for an audit log. The
 * orchestrator MUST treat an `incompatible` outcome as a hard
 * gate: it must NOT create a session for the pair, regardless
 * of what its local (asset, side, institution) filter found.
 */
export interface NegotiationPairVerificationRequest {
  buyTicketHandle: string;
  sellTicketHandle: string;
  buyCompatibilityToken: string;
  sellCompatibilityToken: string;
  assetCode: string;
  correlationRef: string;
}

export interface NegotiationPairVerificationResult {
  /**
   * Deterministic pair identifier: SHA-256 over the
   * lexically-sorted handles + asset code. Same pair → same
   * `pairRef` across retries.
   */
  pairRef: string;
  executionRef: string;
  status: "compatible" | "incompatible";
  /**
   * Empty on `compatible`; non-empty on `incompatible`.
   */
  reason: string;
  /**
   * Empty on `compatible`; one of the stable codes declared in
   * the WIT world comment on `incompatible`.
   */
  reasonCode: string;
  /**
   * Echo of the input handles so the orchestrator's audit log
   * can correlate even on a rejection.
   */
  buyTicketHandle: string;
  sellTicketHandle: string;
  /**
   * Extracted from the buy compatibility token. Empty on
   * `incompatible` if the token did not parse.
   */
  buyInstitutionId: string;
  /**
   * Extracted from the sell compatibility token. Empty on
   * `incompatible` if the token did not parse.
   */
  sellInstitutionId: string;
  assetCode: string;
  expiresAt: string;
  evaluatedAt: string;
}

export interface NegotiationTicketClient {
  sealTicket(request: NegotiationTicketRequest): Promise<NegotiationTicketResult>;
  verifyPair(
    request: NegotiationPairVerificationRequest,
  ): Promise<NegotiationPairVerificationResult>;
}

export interface T3NegotiationTicketClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
  /**
   * Tail path for the `evaluate-pair` route on the same T3
   * contract. Defaults to `evaluate-pair`; the host dispatches
   * by appending the function name to the contract path.
   */
  pairContractPath?: string;
  /**
   * Explicit matching contract version the backend requests
   * from T3N on every `seal-ticket` and `evaluate-pair` call.
   * The T3N adapter (`readVersionFromBody` in `t3n-client.ts`)
   * reads this off the request body and routes execution to
   * the published contract version, so changing it here
   * (after a new publish) repoints the backend without touching
   * the orchestrator. Defaults to `"0.7.0"` — the version that
   * introduced the `evaluate-pair` export, the corrected
   * `seal-ticket` hash that binds `policy_hash` and
   * `compatibility_token` into the handle, and the
   * `evaluate-match` identity-echo + match-attestation binding
   * that lets the orchestrator assert a TEE-attested
   * counterparty identity instead of stamping the in-memory
   * queue. Older versions (e.g. `0.4.0`) silently accept
   * tickets whose compatibility token is not bound to the
   * handle, so an `incompatible` from `evaluate-pair` can be
   * silently bypassed by a forged handle + token combo.
   */
  contractVersion?: string;
}

interface T3NegotiationTicketResponse {
  ticket_handle?: string;
  execution_ref?: string;
}

interface T3NegotiationPairResponse {
  pair_ref?: string;
  execution_ref?: string;
  status?: string;
  reason?: string;
  reason_code?: string;
  buy_ticket_handle?: string;
  sell_ticket_handle?: string;
  buy_institution_id?: string;
  sell_institution_id?: string;
  asset_code?: string;
  expires_at?: string;
}

function opaqueHandle(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `ticket_${digest.slice(0, 32)}`;
}

/**
 * Default contract version when the operator does not pin one
 * via the `T3_MATCHING_CONTRACT_VERSION` env var. v0.7.0 is
 * the production default for `seal-ticket` and `evaluate-pair`
 * — the same contract that powers `evaluate-match` (the audit
 * trail fix lives in `evaluate-match`, but the version bump
 * ships the whole contract forward so the operator only has
 * one pinned version to track). Older versions left the
 * orchestrator as the only match authority and the
 * compatibility token as dead code.
 */
const DEFAULT_NEGOTIATION_CONTRACT_VERSION = "0.7.0";

/**
 * Local fallback when the T3 host omits the `evaluate-pair`
 * route. We compute the same structural checks the Rust
 * contract enforces (well-formed handle, parseable
 * compatibility token, same asset, opposite side, different
 * institution) so the orchestrator's pair gate is never
 * bypassed just because the T3 host didn't echo the new
 * route. This is a defense-in-depth fallback, not a primary
 * path: production hosts return the TEE's verdict verbatim.
 *
 * Returns `incompatible` for any structural failure so the
 * orchestrator treats the fallback the same way it would
 * treat a TEE rejection. The `reason_code` and `reason` are
 * identical to the WIT contract's vocabulary.
 */
function localEvaluatePair(
  request: NegotiationPairVerificationRequest,
): NegotiationPairVerificationResult {
  const evaluatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const pairRefSeed = (() => {
    const sorted = [request.buyTicketHandle, request.sellTicketHandle].sort();
    return `${sorted[0]}|${sorted[1]}|${request.assetCode}`;
  })();
  const pairRef = `pair_${createHash("sha256").update(pairRefSeed).digest("hex").slice(0, 32)}`;
  const executionRef = `t3exec_${randomUUID()}`;

  const reject = (
    reasonCode: string,
    reason: string,
  ): NegotiationPairVerificationResult => ({
    pairRef,
    executionRef,
    status: "incompatible",
    reason,
    reasonCode,
    buyTicketHandle: request.buyTicketHandle,
    sellTicketHandle: request.sellTicketHandle,
    buyInstitutionId: "",
    sellInstitutionId: "",
    assetCode: request.assetCode,
    expiresAt,
    evaluatedAt,
  });

  if (!request.buyTicketHandle.trim()) {
    return reject("missing_buy_ticket_handle", "buy_ticket_handle is required");
  }
  if (!request.sellTicketHandle.trim()) {
    return reject("missing_sell_ticket_handle", "sell_ticket_handle is required");
  }
  if (!request.buyCompatibilityToken.trim()) {
    return reject("missing_buy_compatibility_token", "buy_compatibility_token is required");
  }
  if (!request.sellCompatibilityToken.trim()) {
    return reject("missing_sell_compatibility_token", "sell_compatibility_token is required");
  }
  if (!request.assetCode.trim()) {
    return reject("missing_asset_code", "asset_code is required");
  }
  if (!request.correlationRef.trim()) {
    return reject("missing_correlation_ref", "correlation_ref is required");
  }
  if (!/^ticket_[0-9a-f]{32}$/u.test(request.buyTicketHandle)) {
    return reject(
      "malformed_buy_ticket_handle",
      "buy_ticket_handle is not a well-formed ticket handle",
    );
  }
  if (!/^ticket_[0-9a-f]{32}$/u.test(request.sellTicketHandle)) {
    return reject(
      "malformed_sell_ticket_handle",
      "sell_ticket_handle is not a well-formed ticket handle",
    );
  }
  if (request.buyTicketHandle === request.sellTicketHandle) {
    return reject("self_pair", "buy and sell ticket handles are identical");
  }
  const buyToken = parseCompatibilityToken(request.buyCompatibilityToken);
  if (!buyToken) {
    return reject(
      "malformed_buy_compatibility_token",
      "buy_compatibility_token is not a well-formed <asset>:<side>:<institution> tuple",
    );
  }
  const sellToken = parseCompatibilityToken(request.sellCompatibilityToken);
  if (!sellToken) {
    return reject(
      "malformed_sell_compatibility_token",
      "sell_compatibility_token is not a well-formed <asset>:<side>:<institution> tuple",
    );
  }
  if (buyToken.side !== "buy") {
    return reject("buy_token_wrong_side", "buy_compatibility_token side must be 'buy'");
  }
  if (sellToken.side !== "sell") {
    return reject("sell_token_wrong_side", "sell_compatibility_token side must be 'sell'");
  }
  if (buyToken.asset !== request.assetCode) {
    return reject(
      "buy_token_asset_mismatch",
      "buy_compatibility_token asset does not match asset_code",
    );
  }
  if (sellToken.asset !== request.assetCode) {
    return reject(
      "sell_token_asset_mismatch",
      "sell_compatibility_token asset does not match asset_code",
    );
  }
  if (buyToken.asset !== sellToken.asset) {
    return reject(
      "asset_mismatch",
      "buy and sell compatibility tokens reference different assets",
    );
  }
  if (!buyToken.institutionId || !sellToken.institutionId) {
    return reject(
      buyToken.institutionId ? "missing_sell_institution" : "missing_buy_institution",
      `${buyToken.institutionId ? "sell" : "buy"}_compatibility_token institution_id is empty`,
    );
  }
  if (buyToken.institutionId === sellToken.institutionId) {
    return reject(
      "same_institution",
      "buy and sell compatibility tokens reference the same institution",
    );
  }

  return {
    pairRef,
    executionRef,
    status: "compatible",
    reason: "",
    reasonCode: "",
    buyTicketHandle: request.buyTicketHandle,
    sellTicketHandle: request.sellTicketHandle,
    buyInstitutionId: buyToken.institutionId,
    sellInstitutionId: sellToken.institutionId,
    assetCode: request.assetCode,
    expiresAt,
    evaluatedAt,
  };
}

function parseCompatibilityToken(
  value: string,
): { asset: string; side: string; institutionId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Limit the split to 3 parts so a compatibility token
  // whose `institution_id` contains a colon still parses
  // correctly: the third element keeps the trailing colons
  // intact and the orchestrator's wire form remains
  // forward-compatible with structured institution ids.
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  const asset = (parts[0] ?? "").trim();
  const side = (parts[1] ?? "").trim();
  // Rejoin the rest in case the institution id contains a
  // colon (a future-compatible wire form).
  const institutionId = parts.slice(2).join(":").trim();
  if (!asset || !side || !institutionId) return null;
  if (asset.includes(":") || side.includes(":")) return null;
  return { asset, side, institutionId };
}

export class T3NegotiationTicketClient implements NegotiationTicketClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;
  private readonly pairContractPath: string;
  private readonly contractVersion: string;

  public constructor(options: T3NegotiationTicketClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/negotiation/tickets";
    this.pairContractPath = options.pairContractPath ?? "/contracts/negotiation/pairs";
    this.contractVersion =
      options.contractVersion ?? DEFAULT_NEGOTIATION_CONTRACT_VERSION;
  }

  public async sealTicket(
    request: NegotiationTicketRequest,
  ): Promise<NegotiationTicketResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3NegotiationTicketResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        // The T3N adapter (`readVersionFromBody` in
        // `t3n-client.ts`) reads this sibling `version` field
        // and routes the execution to the published contract
        // version; `extractContractInput` strips it before the
        // body reaches the enclave. Pinning it here means a new
        // publish no longer depends on the tenant's default —
        // the new version is the one bound to the
        // `evaluate-pair` + corrected `seal-ticket` hash.
        version: this.contractVersion,
        institution_id: request.institutionId,
        agent_did: request.agentDid,
        authority_ref: request.authorityRef,
        asset_code: request.assetCode,
        side: request.side,
        policy_hash: request.policyHash,
        compatibility_token: request.compatibilityToken,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 negotiation ticket seal failed.");
    }

    const fallbackSeed = [
      request.institutionId,
      request.agentDid,
      request.authorityRef,
      request.correlationRef,
      randomUUID(),
    ].join(":");

    return {
      ticketHandle: response.body.ticket_handle ?? opaqueHandle(fallbackSeed),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      sealedAt: new Date().toISOString(),
      state: "ticket_sealed",
    };
  }

  public async verifyPair(
    request: NegotiationPairVerificationRequest,
  ): Promise<NegotiationPairVerificationResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3NegotiationPairResponse>({
      method: "POST",
      path: this.pairContractPath,
      body: {
        // Same `version` routing as `sealTicket` — see the
        // comment on the seal body for the full rationale.
        version: this.contractVersion,
        buy_ticket_handle: request.buyTicketHandle,
        sell_ticket_handle: request.sellTicketHandle,
        buy_compatibility_token: request.buyCompatibilityToken,
        sell_compatibility_token: request.sellCompatibilityToken,
        asset_code: request.assetCode,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 negotiation pair verification failed.");
    }

    const body = response.body;
    if (
      typeof body.pair_ref !== "string" ||
      typeof body.execution_ref !== "string" ||
      typeof body.status !== "string"
    ) {
      // The T3 host didn't echo the new route. Fall back to a
      // local structural check that enforces the same rules
      // the Rust contract enforces. This is a defense-in-depth
      // path so a host that hasn't been upgraded can't silently
      // approve a malformed pair.
      return localEvaluatePair(request);
    }

    const evaluatedAt = new Date().toISOString();
    return {
      pairRef: body.pair_ref,
      executionRef: body.execution_ref,
      status: body.status === "compatible" ? "compatible" : "incompatible",
      reason: body.reason ?? "",
      reasonCode: body.reason_code ?? "",
      buyTicketHandle: body.buy_ticket_handle ?? request.buyTicketHandle,
      sellTicketHandle: body.sell_ticket_handle ?? request.sellTicketHandle,
      buyInstitutionId: body.buy_institution_id ?? "",
      sellInstitutionId: body.sell_institution_id ?? "",
      assetCode: body.asset_code ?? request.assetCode,
      expiresAt: body.expires_at ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      evaluatedAt,
    };
  }
}
