import { randomUUID } from "node:crypto";
import type {
  MatchContractClient,
  OpaqueMatchOutcome,
} from "../matching/match-contract-client.js";

/**
 * Confidential per-round negotiation evaluation.
 *
 * `evaluate-round` wraps the existing match contract
 * (`evaluate-match` v0.2.0) so the enclave — not the backend —
 * owns both the crossing decision and the opaque "distance"
 * signal each side sees on its turn. The backend never recomputes
 * the cross, the fill quantity, or the execution price; it
 * persists exactly what the enclave returns.
 *
 * Two confidential properties hold:
 *
 *   1. The numeric reservation thresholds of either side are never
 *      returned. Each side gets only a coarse, bucketed `distance`
 *      label derived inside this module from the standing
 *      proposals, never the counterpart's raw price.
 *   2. On a cross, the authoritative `executionPrice` (midpoint)
 *      and `matchedQuantity` (min) come straight from the match
 *      contract outcome — the same math the instant-intent path
 *      uses today.
 */

export type NegotiationDistanceSignal =
  | "crossed"
  | "near"
  | "moderate"
  | "far";

export interface EvaluateRoundRequest {
  sessionId: string;
  roundNumber: number;
  correlationRef: string;
  assetCode: string;
  /** Buyer's standing bid price, decimal string for exact transport. */
  buyPrice: string;
  /** Buyer's standing quantity, decimal string. */
  buyQuantity: string;
  /** Seller's standing ask price, decimal string. */
  sellPrice: string;
  /** Seller's standing quantity, decimal string. */
  sellQuantity: string;
  /** Opaque handles for the two standing tickets. */
  buyTicketHandle: string;
  sellTicketHandle: string;
}

export interface EvaluateRoundResult {
  status: "crossed" | "open";
  /** Coarse per-side signal — never a raw counterpart threshold. */
  buyerSignal: NegotiationDistanceSignal;
  sellerSignal: NegotiationDistanceSignal;
  /** Authoritative midpoint on a cross; `0` while still open. */
  executionPrice: number;
  /** Authoritative min-fill on a cross; `0` while still open. */
  matchedQuantity: number;
  /** Underlying match outcome ref (opaque), for settlement linkage. */
  outcomeRef: string;
  executionRef: string;
  encryptedTradeFieldsRef: string;
  expiresAt: string;
  evaluatedAt: string;
}

export interface NegotiationRoundEvaluator {
  evaluateRound(request: EvaluateRoundRequest): Promise<EvaluateRoundResult>;
}

function parsePositiveDecimal(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
}

/**
 * Bucket the gap between bid and ask into a coarse signal. The
 * gap is normalized against the ask so the bucket boundaries are
 * scale-invariant. The raw counterpart price is never leaked —
 * only the bucket label crosses the enclave boundary.
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

/**
 * Round evaluator backed by the live match contract. The crossing
 * decision and the fill terms are decided by the enclave contract;
 * this wrapper only computes the coarse per-side distance signal
 * (which never carries a raw counterpart threshold) and shapes the
 * round result for the orchestrator.
 */
export class T3NegotiationRoundEvaluator implements NegotiationRoundEvaluator {
  private readonly matchClient: MatchContractClient;

  public constructor(matchClient: MatchContractClient) {
    this.matchClient = matchClient;
  }

  public async evaluateRound(
    request: EvaluateRoundRequest,
  ): Promise<EvaluateRoundResult> {
    const outcome: OpaqueMatchOutcome = await this.matchClient.evaluateMatch({
      buyIntentHandle: request.buyTicketHandle,
      sellIntentHandle: request.sellTicketHandle,
      correlationRef: request.correlationRef,
      assetCode: request.assetCode,
      buyPrice: request.buyPrice,
      buyQuantity: request.buyQuantity,
      sellPrice: request.sellPrice,
      sellQuantity: request.sellQuantity,
    });

    const crossed = outcome.status === "matched";
    const signal: NegotiationDistanceSignal = crossed
      ? "crossed"
      : distanceSignalFor(
          parsePositiveDecimal(request.buyPrice),
          parsePositiveDecimal(request.sellPrice),
        );

    return {
      status: crossed ? "crossed" : "open",
      buyerSignal: signal,
      sellerSignal: signal,
      executionPrice: crossed ? outcome.executionPrice : 0,
      matchedQuantity: crossed ? outcome.matchedQuantity : 0,
      outcomeRef: outcome.outcomeRef,
      executionRef: outcome.executionRef || `t3exec_${randomUUID()}`,
      encryptedTradeFieldsRef: outcome.encryptedTradeFieldsRef,
      expiresAt: outcome.expiresAt,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
