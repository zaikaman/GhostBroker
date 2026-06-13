import { randomUUID } from "node:crypto";
import type { MatchContractClient } from "@ghostbroker/t3-enclave";
import type {
  SettlementExecutionRequest,
  SettlementService,
} from "./settlement.service.js";
import type { PendingIntent } from "../models/hidden-intent.js";
import type { TelemetryBus } from "./telemetry-bus.js";

/** Default TTL for pending intents: 5 minutes */
const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;
/** Default interval for periodic cleanup sweeps: 30 seconds */
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000;

/**
 * Orchestrates intent matching and settlement.
 *
 * Maintains an in-memory queue of sealed intents. When a new intent arrives,
 * it tries to match it against pending intents from other institutions with
 * the same asset and opposite side. On match, it calls the TEE match contract
 * and triggers settlement.
 *
 * Pending intents that expire (TTL) are automatically evicted.
 */
export class MatchingOrchestrator {
  private readonly matchClient: MatchContractClient;
  private readonly settlementService: SettlementService;
  private readonly telemetryBus: TelemetryBus;
  private readonly intentTtlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private pendingIntents: PendingIntent[] = [];
  private evictedCount = 0;

  public constructor(
    matchClient: MatchContractClient,
    settlementService: SettlementService,
    telemetryBus: TelemetryBus,
    intentTtlMs: number = DEFAULT_INTENT_TTL_MS,
    cleanupIntervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS,
  ) {
    this.matchClient = matchClient;
    this.settlementService = settlementService;
    this.telemetryBus = telemetryBus;
    this.intentTtlMs = intentTtlMs;

    // Start periodic cleanup sweep
    this.cleanupTimer = setInterval(
      () => this.evictExpired(),
      cleanupIntervalMs,
    );
    // Allow the process to exit even if this interval is still active
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Called after an intent has been sealed by the TEE.
   * Adds to the pending queue and attempts to find a match.
   */
  public async onIntentSealed(intent: PendingIntent): Promise<void> {
    // Sweep expired intents before adding the new one
    this.evictExpired();
    this.pendingIntents.push(intent);

    // Try to match against each pending intent from other institutions
    for (let i = 0; i < this.pendingIntents.length; i++) {
      const other = this.pendingIntents[i]!;
      if (other.intentHandle === intent.intentHandle) continue;
      if (other.institutionId === intent.institutionId) continue;
      if (other.assetCode !== intent.assetCode) continue;
      if (other.side === intent.side) continue;

      // Found a potential counterparty — evaluate match
      const buyIntent = intent.side === "buy" ? intent : other;
      const sellIntent = intent.side === "sell" ? intent : other;

      const outcome = await this.matchClient.evaluateMatch({
        buyIntentHandle: buyIntent.intentHandle,
        sellIntentHandle: sellIntent.intentHandle,
        correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
      });

      if (outcome.status === "matched") {
        // Match price: midpoint for demo (TEE would return actual value)
        const matchPrice = Math.round(
          (buyIntent.price + sellIntent.price) / 2,
        );
        const matchQuantity = Math.min(
          buyIntent.quantity,
          sellIntent.quantity,
        );
        // Generate receipt ciphertexts deterministically from the outcome
        const receiptBase = `t3receipt.${outcome.outcomeRef}.${outcome.executionRef}`;

        const request: SettlementExecutionRequest = {
          matchOutcome: outcome,
          buyerAgentDid: buyIntent.agentDid,
          sellerAgentDid: sellIntent.agentDid,
          encryptedTradeFields: {
            assetCodeCiphertext: buyIntent.encryptedEnvelope,
            quantityCiphertext: buyIntent.encryptedEnvelope,
            executionPriceCiphertext: buyIntent.encryptedEnvelope,
          },
          assetCode: buyIntent.assetCode,
          quantity: matchQuantity,
          executionPrice: matchPrice,
          receipts: [
            {
              institutionId: buyIntent.institutionId,
              receiptCiphertext: `${receiptBase}.buyer`,
              receiptHash: `sha256:${outcome.outcomeRef}:buyer`,
              keyVersion: "match-v1",
              t3AttestationRef: outcome.executionRef,
              accessScope: "buyer",
            },
            {
              institutionId: sellIntent.institutionId,
              receiptCiphertext: `${receiptBase}.seller`,
              receiptHash: `sha256:${outcome.outcomeRef}:seller`,
              keyVersion: "match-v1",
              t3AttestationRef: outcome.executionRef,
              accessScope: "seller",
            },
          ],
        };

        await this.settlementService.executeSettlement(
          request,
          `${outcome.outcomeRef}:${randomUUID()}`,
        );

        // Remove matched intents from queue
        this.pendingIntents.splice(i, 1);
        const otherIdx = this.pendingIntents.indexOf(other);
        if (otherIdx >= 0) {
          this.pendingIntents.splice(otherIdx, 1);
        }
        return;
      }
    }
  }

  /**
   * Get current count of pending (unmatched) intents.
   */
  public pendingCount(): number {
    return this.pendingIntents.length;
  }

  /**
   * Stop the periodic cleanup timer.
   * Call this to release resources when the orchestrator is no longer needed.
   */
  public stop(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Get total number of intents evicted due to expiry.
   */
  public getEvictedCount(): number {
    return this.evictedCount;
  }

  /**
   * Remove intents that have exceeded the TTL.
   * Called automatically on each onIntentSealed.
   */
  private evictExpired(): void {
    const cutoff = Date.now() - this.intentTtlMs;
    const evicted: PendingIntent[] = [];
    this.pendingIntents = this.pendingIntents.filter((intent) => {
      const isExpired = new Date(intent.sealedAt).getTime() <= cutoff;
      if (isExpired) {
        evicted.push(intent);
      }
      return !isExpired;
    });

    // Publish telemetry events for evicted intents
    for (const expired of evicted) {
      this.telemetryBus.publish({
        institutionId: expired.institutionId,
        type: "telemetry.processing.changed",
        phase: "intent_expired",
        severity: "warning",
        correlationRef: expired.correlationRef,
        agentId: expired.agentDid,
      });
    }

    this.evictedCount += evicted.length;
  }
}
