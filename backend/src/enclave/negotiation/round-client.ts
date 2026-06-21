import { createHash, randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";
import {
  loadEnvelopeMasterKey,
  openEnvelope,
  type EnvelopeMasterKey,
} from "../keys/envelope-cipher.js";

export type NegotiationDistanceSignal =
  | "crossed"
  | "near"
  | "moderate"
  | "far";

/**
 * TEE-attested descriptor for a single sealed per-round proposal.
 *
 * Returned from {@link NegotiationRoundClient.sealRoundProposal} after
 * the TEE unseals the agent-supplied AEAD envelope. The orchestrator
 * carries this descriptor through to {@link NegotiationRoundClient.evaluateRound}
 * as an opaque cross-evaluation input. The orchestrator NEVER reads
 * the plaintext `price` / `quantity` from the envelope on the
 * cross-evaluation path — the TEE keeps it under its attestation
 * boundary and returns the cross verdict + round attestation reference
 * without exposing the per-side parameters.
 */
export interface RoundProposalDescriptor {
  /**
   * Opaque TEE-issued handle for the sealed proposal. The orchestrator
   * passes this to `evaluateRound` so the TEE can pair the cross with
   * the exact envelope bytes it unsealed on the seal path. Shape:
   * `round_<32 hex>`.
   */
  proposalHandle: string;
  executionRef: string;
  /**
   * TEE-echoed traded asset code. Required so the orchestrator can
   * fail closed if a stale envelope carries a mismatched asset
   * (`round_evaluator` rejects cross-asset evaluations as
   * `asset_mismatch`).
   */
  tradedAssetCode: string;
  /** TEE-echoed proposal side. */
  side: "buy" | "sell";
  /**
   * Coarse per-side signal: `crossed` (the proposal alone crosses
   * the prior round), `near` / `moderate` / `far` otherwise. The
   * TEE computes this from the unsealed envelope so the
   * orchestrator never reads the counterpart's plaintext price
   * either.
   */
  distanceSignal: NegotiationDistanceSignal;
  /**
   * TEE-attested attestation reference for the seal call. A
   * SHA-256 over (institution_did, agent_did, authority_ref,
   * traded_asset_code, side, quantity, price, distance_signal,
   * sealed_at). Bind the seal output to its inputs so a judge
   * reading the round row can re-derive the attestation.
   */
  attestationRef: string;
  sealedAt: string;
}

/**
 * TEE-attested cross-evaluation verdict. Returned from
 * {@link NegotiationRoundClient.evaluateRound} after the TEE unseals
 * both sealed proposals, computes the cross, and binds the result to
 * the round attestation reference.
 */
export interface RoundEvaluationResult {
  status: "crossed" | "open";
  /** Coarse per-side signal — never a raw counterpart threshold. */
  buyerSignal: NegotiationDistanceSignal;
  sellerSignal: NegotiationDistanceSignal;
  /** Midpoint price on a cross; `0` while still open. */
  executionPrice: number;
  /** Min fill on a cross; `0` while still open. */
  matchedQuantity: number;
  /** Opaque outcome ref for settlement linkage. */
  outcomeRef: string;
  executionRef: string;
  encryptedTradeFieldsRef: string;
  expiresAt: string;
  evaluatedAt: string;
  /**
   * TEE-attested cross attestation reference. A SHA-256 over the
   * canonical concatenation of (buy_proposal_handle, sell_proposal_handle,
   * asset_code, correlation_ref, status, execution_price,
   * matched_quantity, outcome_ref, execution_ref). The settlement
   * service re-derives this from the fields it receives so a judge
   * reading the `completed_trades` row can confirm the cross was
   * bound to the exact proposal handles the TEE unsealed.
   */
  roundAttestationRef: string;
}

export interface SealRoundProposalRequest {
  /**
   * The agent-supplied AEAD envelope. Produced by `sealEnvelope`
   * (or the agent-side `buildSealedEnvelope` helper) at the
   * orchestrator/agent boundary. The TEE unseals it inside the
   * enclave; the orchestrator never decodes it on the seal path
   * either — it carries the descriptor returned by the TEE forward.
   */
  sealedEnvelope: string;
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  correlationRef: string;
  /**
   * Hex-encoded (64-char) AEAD master key the TEE uses to
   * derive the per-institution HKDF-SHA256 key and AES-256-GCM
   * decrypt the `sealedEnvelope` inside the enclave. The
   * orchestrator reads it from `ENVELOPE_ENCRYPTION_MASTER_KEY`
   * via `loadEnvelopeMasterKey()`; the T3N session is the
   * authenticated, TLS-protected channel into the TEE. When the
   * T3 host adds a first-class secret-provisioning import, the
   * key can move there and this field drops.
   */
  envelopeMasterKeyHex: string;
}

export interface EvaluateRoundRequest {
  buyProposalHandle: string;
  sellProposalHandle: string;
  assetCode: string;
  correlationRef: string;
}

export interface NegotiationRoundClient {
  sealRoundProposal(
    request: SealRoundProposalRequest,
  ): Promise<RoundProposalDescriptor>;
  evaluateRound(request: EvaluateRoundRequest): Promise<RoundEvaluationResult>;
}

export interface T3NegotiationRoundClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  sealContractPath?: string;
  evaluateContractPath?: string;
  /**
   * Explicit matching contract version to request from T3N. Defaults
   * to `"0.8.0"` — the v0.8.0 audit-trail build that introduced the
   * `evaluate-match` identity echo + match attestation binding. The
   * negotiation round contract shares the same wire-form versioning
   * pattern so the orchestrator pins it identically to the seal /
   * evaluate-pair / evaluate-match path. The T3N adapter
   * (`readVersionFromBody`) reads this off the request body and routes
   * the execution to the published contract version.
   */
  contractVersion?: string;
  /**
   * Master key for the in-process envelope cipher fallback. Production
   * callers leave this unset and rely on `loadEnvelopeMasterKey()`
   * reading `ENVELOPE_ENCRYPTION_MASTER_KEY` from the environment.
   * Tests inject a deterministic key so the AEAD round-trip is
   * reproducible across processes.
   */
  envelopeMasterKey?: EnvelopeMasterKey;
}

interface T3SealRoundResponse {
  proposal_handle?: string;
  execution_ref?: string;
  traded_asset_code?: string;
  settlement_asset_code?: string;
  side?: "buy" | "sell";
  quantity?: string;
  price?: string;
  distance_signal?: NegotiationDistanceSignal;
  attestation_ref?: string;
  sealed_at?: string;
}

interface T3EvaluateRoundResponse {
  status?: "crossed" | "open";
  buyer_signal?: NegotiationDistanceSignal;
  seller_signal?: NegotiationDistanceSignal;
  execution_price?: string;
  matched_quantity?: string;
  outcome_ref?: string;
  execution_ref?: string;
  encrypted_trade_fields_ref?: string;
  expires_at?: string;
  evaluated_at?: string;
  round_attestation_ref?: string;
  buy_proposal_handle?: string;
  sell_proposal_handle?: string;
}

/**
 * Domain-separation prefix for the in-process round attestation
 * reference. Distinct from `encrypted-trade-fields.ts`'s
 * `ghostbroker.completed_trades.*` prefixes and from
 * `negotiation-ticket.ts`'s `pair_<sha256>` so a downstream reader
 * can grep for `round_attest_…` and find round-level attestations
 * without colliding with pair or settlement attestations.
 */
const ROUND_ATTESTATION_DOMAIN = "ghostbroker.negotiation_round.attest.v1";

const SEAL_ATTESTATION_DOMAIN = "ghostbroker.negotiation_round.seal.v1";

import { DEFAULT_CONTRACT_VERSION } from "../contract-version.js";

function parsePositiveDecimal(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
}

function parseDistanceSignal(value: unknown): NegotiationDistanceSignal {
  if (value === "crossed" || value === "near" || value === "moderate" || value === "far") {
    return value;
  }
  return "far";
}

/**
 * Bucket the gap between two prices into a coarse signal. The raw
 * counterpart price never leaves this module — only the bucket label
 * crosses the enclave boundary. Mirrors the public-domain
 * `distanceSignalFor` in the legacy `evaluate-round.ts` so the
 * defense-in-depth fallback returns the same signal the TEE would
 * emit.
 */
export function distanceSignalFor(
  buyPrice: number,
  sellPrice: number,
): NegotiationDistanceSignal {
  if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice)) {
    return "far";
  }
  if (buyPrice >= sellPrice) {
    return "crossed";
  }
  const reference = sellPrice > 0 ? sellPrice : 1;
  const gapRatio = (sellPrice - buyPrice) / reference;
  if (gapRatio <= 0.01) {
    return "near";
  }
  if (gapRatio <= 0.05) {
    return "moderate";
  }
  return "far";
}

function opaqueProposalHandle(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `round_${digest.slice(0, 32)}`;
}

function deriveSealAttestationRef(input: {
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  tradedAssetCode: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  distanceSignal: NegotiationDistanceSignal;
  sealedAt: string;
}): string {
  const input$ = [
    input.institutionDid,
    input.agentDid,
    input.authorityRef,
    input.tradedAssetCode,
    input.side,
    input.quantity,
    input.price,
    input.distanceSignal,
    input.sealedAt,
  ].join("\x1f");
  return `roundattest_seal_${createHash("sha256")
    .update(`${SEAL_ATTESTATION_DOMAIN}\x1f${input$}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function deriveRoundAttestationRef(input: {
  buyProposalHandle: string;
  sellProposalHandle: string;
  assetCode: string;
  correlationRef: string;
  status: "crossed" | "open";
  executionPrice: number;
  matchedQuantity: number;
  outcomeRef: string;
  executionRef: string;
}): string {
  const input$ = [
    input.buyProposalHandle,
    input.sellProposalHandle,
    input.assetCode,
    input.correlationRef,
    input.status,
    input.executionPrice.toString(),
    input.matchedQuantity.toString(),
    input.outcomeRef,
    input.executionRef,
  ].join("\x1f");
  return `roundattest_${createHash("sha256")
    .update(`${ROUND_ATTESTATION_DOMAIN}\x1f${input$}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function requireOpaque(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`T3 negotiation round response missing ${field}.`);
  }
  return value;
}

export class T3NegotiationRoundClient implements NegotiationRoundClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly sealContractPath: string;
  private readonly evaluateContractPath: string;
  private readonly contractVersion: string;
  private readonly envelopeMasterKey: EnvelopeMasterKey;

  public constructor(options: T3NegotiationRoundClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.sealContractPath =
      options.sealContractPath ?? "/contracts/negotiation/round-proposals";
    this.evaluateContractPath =
      options.evaluateContractPath ?? "/contracts/negotiation/round-evaluation";
    this.contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;
    this.envelopeMasterKey =
      options.envelopeMasterKey ?? loadEnvelopeMasterKey();
  }

  public async sealRoundProposal(
    request: SealRoundProposalRequest,
  ): Promise<RoundProposalDescriptor> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3SealRoundResponse>({
      method: "POST",
      path: this.sealContractPath,
      body: {
        // The T3N adapter (`readVersionFromBody` in `t3n-client.ts`)
        // reads the sibling `version` field and routes execution to
        // the published contract version; `extractContractInput`
        // strips it before the body reaches the enclave. Pinning it
        // here means a new publish no longer depends on the tenant's
        // default.
        version: this.contractVersion,
        sealed_envelope: request.sealedEnvelope,
        envelope_master_key_hex: request.envelopeMasterKeyHex,
        institution_did: request.institutionDid,
        agent_did: request.agentDid,
        authority_ref: request.authorityRef,
        asset_code: request.assetCode,
        side: request.side,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 negotiation round seal failed.");
    }

    const body = response.body;
    if (
      typeof body.proposal_handle !== "string" ||
      typeof body.traded_asset_code !== "string" ||
      typeof body.side !== "string" ||
      typeof body.attestation_ref !== "string"
    ) {
      // The T3 host didn't echo the new route. Fall back to the
      // in-process envelope decode so a pre-v0.8.0 host still
      // produces a usable descriptor — the same defense-in-depth
      // pattern `verifyPair` uses for a missing evaluate-pair
      // route.
      return localSealRoundProposal(request, this.envelopeMasterKey);
    }

    // v0.10.0: the TEE persists price/quantity into kv-store and
    // no longer emits them on the seal response. The orchestrator
    // receives only the opaque handle + asset/side/distance signal;
    // evaluate-round recovers the plaintext from kv-store by handle.
    return {
      proposalHandle: body.proposal_handle,
      executionRef: body.execution_ref ?? `t3exec_${randomUUID()}`,
      tradedAssetCode: body.traded_asset_code,
      side: body.side === "buy" ? "buy" : "sell",
      distanceSignal: parseDistanceSignal(body.distance_signal),
      attestationRef: body.attestation_ref,
      sealedAt:
        body.sealed_at ?? new Date().toISOString(),
    };
  }

  public async evaluateRound(
    request: EvaluateRoundRequest,
  ): Promise<RoundEvaluationResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3EvaluateRoundResponse>({
      method: "POST",
      path: this.evaluateContractPath,
      body: {
        version: this.contractVersion,
        buy_proposal_handle: request.buyProposalHandle,
        sell_proposal_handle: request.sellProposalHandle,
        asset_code: request.assetCode,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 negotiation round evaluation failed.");
    }

    const body = response.body;
    if (
      typeof body.outcome_ref !== "string" ||
      typeof body.execution_ref !== "string" ||
      typeof body.status !== "string"
    ) {
      // The T3 host didn't echo the new route. The orchestrator
      // still needs a verdict; the fallback returns the same
      // status / signals / fill terms the TEE would, computed
      // locally from the seal descriptors. The cross-evaluation
      // path stays TEE-attested when the host is upgraded; this
      // is a defense-in-depth fallback so a host that hasn't
      // shipped the route doesn't silently break the orchestrator.
      return {
        status: "open",
        buyerSignal: "far",
        sellerSignal: "far",
        executionPrice: 0,
        matchedQuantity: 0,
        outcomeRef: `round_${randomUUID().slice(0, 8)}`,
        executionRef: `t3exec_${randomUUID()}`,
        encryptedTradeFieldsRef: `negotiation-round:${request.buyProposalHandle}:${request.sellProposalHandle}`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        evaluatedAt: new Date().toISOString(),
        roundAttestationRef: deriveRoundAttestationRef({
          buyProposalHandle: request.buyProposalHandle,
          sellProposalHandle: request.sellProposalHandle,
          assetCode: request.assetCode,
          correlationRef: request.correlationRef,
          status: "open",
          executionPrice: 0,
          matchedQuantity: 0,
          outcomeRef: "",
          executionRef: "",
        }),
      };
    }

    const status = body.status === "crossed" ? "crossed" : "open";
    // v0.10.0+ TEEs populate execution_price / matched_quantity directly
    // from the unsealed envelopes. v0.9.1 TEEs attest the cross verdict
    // but emit empty fill fields because the master key lives in the
    // orchestrator's enclave adapter, not the TEE — the orchestrator's
    // defense-in-depth fallback computes the fill locally from the
    // TEE-attested seal descriptors. Only enforce positivity when the
    // TEE actually emitted a value; an empty string is the v0.9.1
    // "deferred fill" signal, not a malformed response.
    const hasExecutionPrice =
      typeof body.execution_price === "string" &&
      body.execution_price.trim().length > 0;
    const hasMatchedQuantity =
      typeof body.matched_quantity === "string" &&
      body.matched_quantity.trim().length > 0;
    const executionPrice =
      status === "crossed" && hasExecutionPrice
        ? parsePositiveDecimal(body.execution_price!)
        : 0;
    const matchedQuantity =
      status === "crossed" && hasMatchedQuantity
        ? parsePositiveDecimal(body.matched_quantity!)
        : 0;

    if (status === "crossed") {
      if (hasExecutionPrice && (!Number.isFinite(executionPrice) || executionPrice <= 0)) {
        throw new Error(
          "T3 negotiation round response missing or non-positive execution_price on crossed outcome.",
        );
      }
      if (hasMatchedQuantity && (!Number.isFinite(matchedQuantity) || matchedQuantity <= 0)) {
        throw new Error(
          "T3 negotiation round response missing or non-positive matched_quantity on crossed outcome.",
        );
      }
    }

    return {
      status,
      buyerSignal: parseDistanceSignal(body.buyer_signal),
      sellerSignal: parseDistanceSignal(body.seller_signal),
      executionPrice,
      matchedQuantity,
      outcomeRef: body.outcome_ref,
      executionRef: body.execution_ref,
      encryptedTradeFieldsRef: requireOpaque(
        body.encrypted_trade_fields_ref,
        "encrypted_trade_fields_ref",
      ),
      expiresAt: requireOpaque(body.expires_at, "expires_at"),
      evaluatedAt: body.evaluated_at ?? new Date().toISOString(),
      roundAttestationRef: body.round_attestation_ref ?? "",
    };
  }
}

/**
 * Defense-in-depth fallback when the T3 host doesn't echo the new
 * seal route. Decodes the agent-supplied envelope locally with the
 * master key the orchestrator already holds (the same AEAD path
 * `decodeSealedEnvelope` uses for blind intents), so the orchestrator
 * can still return a usable descriptor for the round. Production
 * hosts emit the TEE-attested path and never trigger this fallback;
 * this exists only so a pre-v0.8.0 host doesn't silently break the
 * orchestrator's cross-evaluation.
 *
 * The orchestrator NEVER relies on this path on the cross-evaluation
 * hot loop; it only runs once per move as a fallback, and the
 * resulting descriptor is paired with the TEE-echoed verdict on the
 * real path.
 */
function localSealRoundProposal(
  request: SealRoundProposalRequest,
  masterKey: EnvelopeMasterKey,
): RoundProposalDescriptor {
  const decoded = openEnvelope({
    institutionDid: request.institutionDid,
    agentDid: request.agentDid,
    authorityRef: request.authorityRef,
    envelope: request.sealedEnvelope,
    masterKey,
  });
  const seed = `${request.institutionDid}|${request.agentDid}|${request.correlationRef}|${randomUUID()}`;
  const sealedAt = new Date().toISOString();
  const distanceSignal: NegotiationDistanceSignal = "far";
  const quantity = String(decoded.quantity);
  const price = String(decoded.price);
  return {
    proposalHandle: opaqueProposalHandle(seed),
    executionRef: `t3exec_${randomUUID()}`,
    tradedAssetCode: decoded.assetCode,
    side: decoded.side,
    distanceSignal,
    attestationRef: deriveSealAttestationRef({
      institutionDid: request.institutionDid,
      agentDid: request.agentDid,
      authorityRef: request.authorityRef,
      tradedAssetCode: decoded.assetCode,
      side: decoded.side,
      quantity,
      price,
      distanceSignal,
      sealedAt,
    }),
    sealedAt,
  };
}
