import { randomUUID } from "node:crypto";
import type { MatchContractClient } from "@ghostbroker/t3-enclave";
import type {
  SettlementExecutionRequest,
  SettlementService,
} from "./settlement.service.js";
import type { PendingIntent } from "../models/hidden-intent.js";

/**
 * Orchestrates intent matching and settlement.
 *
 * Maintains an in-memory queue of sealed intents. When a new intent arrives,
 * it tries to match it against pending intents from other institutions with
 * the same asset and opposite side. On match, it calls the TEE match contract
 * and triggers settlement.
 */
export class MatchingOrchestrator {
  private readonly pendingIntents: PendingIntent[] = [];
  private readonly matchClient: MatchContractClient;
  private readonly settlementService: SettlementService;

  public constructor(
    matchClient: MatchContractClient,
    settlementService: SettlementService,
  ) {
    this.matchClient = matchClient;
    this.settlementService = settlementService;
  }

  /**
   * Called after an intent has been sealed by the TEE.
   * Adds to the pending queue and attempts to find a match.
   */
  public async onIntentSealed(intent: PendingIntent): Promise<void> {
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
}
