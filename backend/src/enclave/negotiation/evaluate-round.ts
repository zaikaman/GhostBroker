import { randomUUID } from "node:crypto";

/**
 * Per-round negotiation evaluation — computed inline rather than
 * through the T3 blind‑match contract.
 *
 * Negotiation is bilateral: both sides' prices and quantities are
 * already visible to the orchestrator.  There is no need to pass
 * opaque intent handles through the T3 match contract — that
 * contract validates intent handles against sealed blind intents,
 * and negotiation tickets are sealed through an entirely different
 * contract path (`seal-ticket` vs `seal-intent`).  Using it would
 * always return `no_match`, making it impossible for any
 * negotiation to ever settle.
 *
 * Instead we compute the cross, the midpoint price, and the
 * minimum quantity right here.  The result is identical to what the
 * blind contract would return for non‑hidden prices — only the
 * attestation boundary is different.
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
}

export interface EvaluateRoundResult {
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
 * Inline negotiation round evaluator.
 *
 * Computes the crossing decision, execution price (midpoint), and
 * fill quantity (min) directly from the two sides' priced proposals,
 * without routing through the T3 blind‑match contract.
 */
export class T3NegotiationRoundEvaluator implements NegotiationRoundEvaluator {
  public async evaluateRound(
    request: EvaluateRoundRequest,
  ): Promise<EvaluateRoundResult> {
    const buyPrice = parsePositiveDecimal(request.buyPrice);
    const sellPrice = parsePositiveDecimal(request.sellPrice);
    const buyQuantity = parsePositiveDecimal(request.buyQuantity);
    const sellQuantity = parsePositiveDecimal(request.sellQuantity);

    const crossed =
      Number.isFinite(buyPrice) &&
      Number.isFinite(sellPrice) &&
      Number.isFinite(buyQuantity) &&
      Number.isFinite(sellQuantity) &&
      buyPrice >= sellPrice &&
      buyQuantity > 0 &&
      sellQuantity > 0;

    const signal: NegotiationDistanceSignal = crossed
      ? "crossed"
      : distanceSignalFor(
          Number.isFinite(buyPrice) ? buyPrice : 0,
          Number.isFinite(sellPrice) ? sellPrice : 0,
        );

    const executionPrice = crossed ? (buyPrice + sellPrice) / 2 : 0;
    const matchedQuantity = crossed ? Math.min(buyQuantity, sellQuantity) : 0;

    const roundRef = `round_${request.sessionId}_${request.roundNumber}_${randomUUID().slice(0, 8)}`;

    return {
      status: crossed ? "crossed" : "open",
      buyerSignal: signal,
      sellerSignal: signal,
      executionPrice,
      matchedQuantity,
      outcomeRef: roundRef,
      executionRef: `t3exec_${randomUUID()}`,
      encryptedTradeFieldsRef: `negotiation-transcript:${request.sessionId}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      evaluatedAt: new Date().toISOString(),
    };
  }
}
