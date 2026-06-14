import { randomUUID } from "node:crypto";
import type { MatchContractClient } from "@ghostbroker/t3-enclave";
import type {
  SettlementExecutionRequest,
  SettlementService,
} from "./settlement.service.js";
import type { PendingIntent } from "../models/hidden-intent.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { PortfolioService } from "./portfolio.service.js";
import type { IntentLockRepository } from "./intent-lock-repository.js";

/** Default TTL for pending intents: 5 minutes */
const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;
/** Default interval for periodic cleanup sweeps: 30 seconds */
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000;

/**
 * A balance reservation is the per-intent lock on an institution's
 * available balance. The orchestrator holds the lock while the
 * intent is pending and releases it on cancel, eviction, or
 * revocation. Settlement releases the lock implicitly via the
 * `portfolio_update_balance` SQL function, which clamps
 * `locked = LEAST(locked, new_balance)` as the balance drains.
 */
interface BalanceReservation {
  institutionId: string;
  assetCode: string;
  amount: number;
}

/**
 * Orchestrates intent matching and settlement with pre-match
 * authorization enforcement.
 *
 * Before calling the TEE match contract, the orchestrator checks:
 * 1. Buyer has sufficient settlement asset balance (quantity × price)
 * 2. Seller has sufficient asset balance
 * 3. Intent side matches the agent's direction scope (if available)
 * 4. Asset is within the agent's instrument scope (if available)
 * 5. Notional value does not exceed agent's maxNotional (if available)
 *
 * On match, it calls the TEE match contract and triggers settlement.
 * Pending intents that expire (TTL) are automatically evicted.
 */
export class MatchingOrchestrator {
  private readonly matchClient: MatchContractClient;
  private readonly settlementService: SettlementService;
  private readonly telemetryBus: TelemetryBus;
  private readonly portfolioService: PortfolioService | undefined;
  /**
   * The asset code used for settlement (typically USDC). Exposed
   * as read-only so the portfolios route can compute the locked
   * amount for a buy intent without re-deriving it from the
   * environment.
   */
  public readonly settlementAssetCode: string;
  private readonly intentTtlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly intentLockRepository: IntentLockRepository | undefined;
  private pendingIntents: PendingIntent[] = [];
  private evictedCount = 0;

  public constructor(
    matchClient: MatchContractClient,
    settlementService: SettlementService,
    telemetryBus: TelemetryBus,
    portfolioService?: PortfolioService,
    settlementAssetCode = "USDC",
    intentTtlMs: number = DEFAULT_INTENT_TTL_MS,
    cleanupIntervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS,
    intentLockRepository?: IntentLockRepository,
  ) {
    this.matchClient = matchClient;
    this.settlementService = settlementService;
    this.telemetryBus = telemetryBus;
    this.portfolioService = portfolioService;
    this.intentLockRepository = intentLockRepository;
    this.settlementAssetCode = settlementAssetCode;
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
   * Compute the balance reservation descriptor for a pending intent.
   *
   * - A buy intent locks `quantity * price` units of the
   *   settlement asset (USDC) at the buyer's institution.
   * - A sell intent locks `quantity` units of the traded asset
   *   at the seller's institution.
   *
   * Public so that the service layer can acquire the same lock
   * the orchestrator will later release — keeping the lock
   * descriptor formula in one place.
   */
  public lockDescriptorFor(intent: PendingIntent): BalanceReservation {
    if (intent.side === "buy") {
      return {
        institutionId: intent.institutionId,
        assetCode: this.settlementAssetCode,
        amount: intent.quantity * intent.price,
      };
    }
    return {
      institutionId: intent.institutionId,
      assetCode: intent.assetCode,
      amount: intent.quantity,
    };
  }

  /**
   * Release the lock for a single intent. Best-effort: errors
   * from the portfolio service are logged inside the service and
   * never thrown, so the orchestrator's own state mutation is
   * unaffected by transient DB failures.
   */
  private releaseLockFor(intent: PendingIntent): void {
    if (!this.portfolioService) {
      return;
    }
    const reservation = this.lockDescriptorFor(intent);
    void this.portfolioService.releaseBalance(
      reservation.institutionId,
      reservation.assetCode,
      reservation.amount,
    );
  }

  /**
   * Delete the durable lock ref for a single intent. Best-effort:
   * the in-memory queue mutation is unaffected by transient DB
   * failures. If the delete fails, the orphan-lock janitor will
   * eventually `releaseBalance` the corresponding amount
   * (clamped at zero, since the actual lock has already been
   * released) and try to delete the ref again.
   */
  private deleteLockRefFor(intent: PendingIntent): void {
    if (!this.intentLockRepository) {
      return;
    }
    void this.intentLockRepository.delete(intent.intentHandle).catch(
      (error: unknown) => {
        console.error(
          `[MatchingOrchestrator] Failed to delete lock ref for ${intent.intentHandle}:`,
          error,
        );
      },
    );
  }

  /**
   * Called after an intent has been sealed AND the balance lock
   * has been acquired by the service. Adds the intent to the
   * pending queue and attempts to find a match.
   *
   * Note: lock acquisition lives in `HiddenIntentService.submitIntent`
   * so that lock failures can be surfaced to the agent as a 403
   * *before* the HTTP 202 is sent. This method does not need to
   * lock.
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

      // Found a potential counterparty — run pre-match checks
      const buyIntent = intent.side === "buy" ? intent : other;
      const sellIntent = intent.side === "sell" ? intent : other;
      const matchQuantity = Math.min(
        buyIntent.quantity,
        sellIntent.quantity,
      );
      const matchPrice = Math.round(
        (buyIntent.price + sellIntent.price) / 2,
      );

      // Pre-match check 1: Verify buyer has sufficient balance
      if (this.portfolioService) {
        const balanceCheck = await this.checkBalance(
          buyIntent,
          sellIntent,
          matchQuantity,
          matchPrice,
        );
        if (!balanceCheck.passed) {
          const failingInstitutionId = balanceCheck.side === "seller"
            ? sellIntent.institutionId
            : buyIntent.institutionId;
          this.telemetryBus.publish({
            institutionId: failingInstitutionId,
            type: "telemetry.error.changed",
            phase: "authorization_failed",
            severity: "error",
            correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
            agentId: buyIntent.agentDid,
          });
          // Pre-match check failed: release the counterparty's
          // lock + ref so its available balance is restored
          // immediately, rather than waiting for TTL eviction.
          this.releaseLockFor(other);
          this.deleteLockRefFor(other);
          this.pendingIntents.splice(i, 1);
          this.removeIntent(other);
          return;
        }
      }

      // Pre-match check 2: Verify agent direction scope
      const directionCheck = this.checkDirectionScope(
        buyIntent,
        sellIntent,
      );
      if (!directionCheck.passed) {
        this.telemetryBus.publish({
          institutionId: directionCheck.institutionId,
          type: "telemetry.error.changed",
          phase: "authorization_failed",
          severity: "error",
          correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
          agentId: directionCheck.agentDid,
        });
        // Pre-match check failed: release the counterparty's
        // lock + ref so its available balance is restored
        // immediately, rather than waiting for TTL eviction.
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

      // Pre-match check 3: Verify instrument scope
      const instrumentCheck = this.checkInstrumentScope(
        buyIntent,
        sellIntent,
      );
      if (!instrumentCheck.passed) {
        this.telemetryBus.publish({
          institutionId: instrumentCheck.institutionId,
          type: "telemetry.error.changed",
          phase: "authorization_failed",
          severity: "error",
          correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
          agentId: instrumentCheck.agentDid,
        });
        // Pre-match check failed: release the counterparty's
        // lock + ref so its available balance is restored
        // immediately, rather than waiting for TTL eviction.
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

      // Pre-match check 4: Verify max notional
      const notionalCheck = this.checkMaxNotional(
        buyIntent,
        sellIntent,
        matchQuantity,
        matchPrice,
      );
      if (!notionalCheck.passed) {
        this.telemetryBus.publish({
          institutionId: notionalCheck.institutionId,
          type: "telemetry.error.changed",
          phase: "authorization_failed",
          severity: "error",
          correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
          agentId: notionalCheck.agentDid,
        });
        // Pre-match check failed: release the counterparty's
        // lock + ref so its available balance is restored
        // immediately, rather than waiting for TTL eviction.
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

      // Evaluate match via TEE
      const outcome = await this.matchClient.evaluateMatch({
        buyIntentHandle: buyIntent.intentHandle,
        sellIntentHandle: sellIntent.intentHandle,
        correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
      });

      if (outcome.status === "matched") {
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

        // Capture refs to the matched intents before we mutate
        // the queue — we need them to delete the durable lock
        // refs. Settlement itself releases the `portfolios.locked`
        // amount implicitly via the SQL clamp in
        // `portfolio_update_balance`; here we just need to
        // remove the rows from `intent_locks` so the janitor
        // does not see them.
        this.deleteLockRefFor(intent);
        this.deleteLockRefFor(other);

        // Remove matched intents from queue
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }
    }
  }

  /**
   * Run pre-match balance checks.
   * Returns { passed: true } if both sides have sufficient balance.
   */


  /**
   * Run pre-match balance checks.
   * Returns { passed: true } if both sides have sufficient balance,
   * or { passed: false, side: "buyer"|"seller" } identifying which side failed.
   */
  private async checkBalance(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
    matchQuantity: number,
    matchPrice: number,
  ): Promise<{
    passed: boolean;
    side?: "buyer" | "seller";
    reason?: string;
  }> {
    if (!this.portfolioService) {
      return { passed: true };
    }

    try {
      const totalCost = matchQuantity * matchPrice;

      // Check buyer has enough *available* settlement asset
      // (balance - locked, where locked includes the buy intent's
      // own reservation).
      const buyerPortfolio = await this.portfolioService.getPortfolio(
        buyIntent.institutionId,
      );
      const buyerCash = buyerPortfolio.holdings.find(
        (h) => h.assetCode === this.settlementAssetCode,
      );
      const buyerAvailable = (buyerCash?.balance ?? 0) - (buyerCash?.locked ?? 0);
      if (!buyerCash || buyerAvailable < totalCost) {
        return {
          passed: false,
          side: "buyer",
          reason: `Buyer ${
            buyIntent.institutionId
          } has insufficient ${
            this.settlementAssetCode
          } available balance: has ${buyerAvailable}, needs ${totalCost}`,
        };
      }

      // Check seller has enough *available* of the asset
      const sellerPortfolio = await this.portfolioService.getPortfolio(
        sellIntent.institutionId,
      );
      const sellerAsset = sellerPortfolio.holdings.find(
        (h) => h.assetCode === sellIntent.assetCode,
      );
      const sellerAvailable = (sellerAsset?.balance ?? 0) - (sellerAsset?.locked ?? 0);
      if (!sellerAsset || sellerAvailable < matchQuantity) {
        return {
          passed: false,
          side: "seller",
          reason: `Seller ${
            sellIntent.institutionId
          } has insufficient ${
            sellIntent.assetCode
          } available balance: has ${sellerAvailable}, needs ${matchQuantity}`,
        };
      }

      return { passed: true };
    } catch {
      // If portfolio service is unavailable, allow the match to proceed
      // (the settlement service will also check balances)
      return { passed: true };
    }
  }

  /**
   * Verify the intent side is within the agent's direction scope.
   */
  private checkDirectionScope(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
  ): { passed: boolean; institutionId: string; agentDid: string; reason?: string } {
    if (buyIntent.directionScope) {
      if (!buyIntent.directionScope.includes("buy")) {
        return {
          passed: false,
          institutionId: buyIntent.institutionId,
          agentDid: buyIntent.agentDid,
          reason: `Buy agent ${buyIntent.agentDid} not authorized to buy (direction scope: ${buyIntent.directionScope.join(", ")})`,
        };
      }
    }
    if (sellIntent.directionScope) {
      if (!sellIntent.directionScope.includes("sell")) {
        return {
          passed: false,
          institutionId: sellIntent.institutionId,
          agentDid: sellIntent.agentDid,
          reason: `Sell agent ${sellIntent.agentDid} not authorized to sell (direction scope: ${sellIntent.directionScope.join(", ")})`,
        };
      }
    }
    return { passed: true, institutionId: "", agentDid: "" };
  }

  /**
   * Verify the trade asset is within the agent's instrument scope.
   */
  private checkInstrumentScope(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
  ): { passed: boolean; institutionId: string; agentDid: string; reason?: string } {
    if (buyIntent.instrumentScope && !buyIntent.instrumentScope.includes(buyIntent.assetCode)) {
      return {
        passed: false,
        institutionId: buyIntent.institutionId,
        agentDid: buyIntent.agentDid,
        reason: `Buy agent ${buyIntent.agentDid} not authorized to trade ${buyIntent.assetCode} (instrument scope: ${buyIntent.instrumentScope.join(", ")})`,
      };
    }
    if (sellIntent.instrumentScope && !sellIntent.instrumentScope.includes(sellIntent.assetCode)) {
      return {
        passed: false,
        institutionId: sellIntent.institutionId,
        agentDid: sellIntent.agentDid,
        reason: `Sell agent ${sellIntent.agentDid} not authorized to trade ${sellIntent.assetCode} (instrument scope: ${sellIntent.instrumentScope.join(", ")})`,
      };
    }
    return { passed: true, institutionId: "", agentDid: "" };
  }

  /**
   * Verify the trade notional (quantity × price) is within the agent's max.
   */
  private checkMaxNotional(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
    matchQuantity: number,
    matchPrice: number,
  ): { passed: boolean; institutionId: string; agentDid: string; reason?: string } {
    const totalCost = BigInt(Math.round(matchQuantity * matchPrice));

    if (buyIntent.maxNotional) {
      const limit = BigInt(buyIntent.maxNotional);
      if (totalCost > limit) {
        return {
          passed: false,
          institutionId: buyIntent.institutionId,
          agentDid: buyIntent.agentDid,
          reason: `Buy agent ${buyIntent.agentDid} notional ${totalCost} exceeds max ${limit}`,
        };
      }
    }
    if (sellIntent.maxNotional) {
      const limit = BigInt(sellIntent.maxNotional);
      if (totalCost > limit) {
        return {
          passed: false,
          institutionId: sellIntent.institutionId,
          agentDid: sellIntent.agentDid,
          reason: `Sell agent ${sellIntent.agentDid} notional ${totalCost} exceeds max ${limit}`,
        };
      }
    }
    return { passed: true, institutionId: "", agentDid: "" };
  }

  /**
   * Remove a specific intent from the pending queue.
   */
  private removeIntent(intent: PendingIntent): void {
    const idx = this.pendingIntents.indexOf(intent);
    if (idx >= 0) {
      this.pendingIntents.splice(idx, 1);
    }
  }

  /**
   * Cancel a single pending intent by its handle.
   *
   * Returns the removed intent if it was present in the queue, or
   * `undefined` if no matching intent was found (already matched,
   * already expired, never existed, or owned by a different agent /
   * institution).
   *
   * Only the original submitting agent may cancel. The agent's
   * authority must still be live (we don't re-verify the cryptographic
   * proof here — the cancel route does that — but ownership is
   * enforced by the handle + agentDid + institutionId triple).
   */
  public cancelIntent(params: {
    intentHandle: string;
    agentDid: string;
    institutionId: string;
  }): PendingIntent | undefined {
    const idx = this.pendingIntents.findIndex(
      (intent) =>
        intent.intentHandle === params.intentHandle &&
        intent.agentDid === params.agentDid &&
        intent.institutionId === params.institutionId,
    );

    if (idx < 0) {
      return undefined;
    }

    const [removed] = this.pendingIntents.splice(idx, 1);

    if (removed) {
      // Release the per-intent balance lock. Best-effort: the
      // releaseBalance call swallows its own errors, so the
      // in-memory state mutation above stands even if the DB
      // release fails.
      this.releaseLockFor(removed);
      // Delete the durable lock ref so the orphan-lock janitor
      // does not see a stale row.
      this.deleteLockRefFor(removed);

      this.telemetryBus.publish({
        institutionId: removed.institutionId,
        type: "telemetry.processing.changed",
        phase: "intent_cancelled",
        severity: "warning",
        correlationRef: removed.correlationRef,
        agentId: removed.agentDid,
      });
    }

    return removed;
  }

  /**
   * Remove all pending intents for a given agent/institution.
   * Used when an agent is revoked — clears their active intents from the queue.
   */
  public removeIntentsByAgent(agentDid: string, institutionId: string): void {
    const removed: PendingIntent[] = [];
    this.pendingIntents = this.pendingIntents.filter((intent) => {
      const matches =
        intent.agentDid === agentDid &&
        intent.institutionId === institutionId;
      if (matches) {
        removed.push(intent);
      }
      return !matches;
    });

    for (const intent of removed) {
      // Release the per-intent balance lock so the institution's
      // available balance is restored when the agent is revoked.
      this.releaseLockFor(intent);
      this.deleteLockRefFor(intent);

      this.telemetryBus.publish({
        institutionId: intent.institutionId,
        type: "telemetry.processing.changed",
        phase: "intent_cancelled",
        severity: "warning",
        correlationRef: intent.correlationRef,
        agentId: intent.agentDid,
      });
    }
  }

  /**
   * Get current count of pending (unmatched) intents.
   */
  public pendingCount(): number {
    return this.pendingIntents.length;
  }

  /**
   * List pending intents for the given institution, optionally
   * filtered to a single agent. Returns a shallow copy of the
   * matching records (callers cannot mutate internal queue state).
   *
   * This is a synchronous read against the in-memory queue — safe
   * to call from request handlers.
   */
  public listPendingIntents(params: {
    institutionId: string;
    agentDid?: string;
  }): ReadonlyArray<PendingIntent> {
    return this.pendingIntents.filter((intent) => {
      if (intent.institutionId !== params.institutionId) {
        return false;
      }
      if (params.agentDid && intent.agentDid !== params.agentDid) {
        return false;
      }
      return true;
    });
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

    // Publish telemetry events for evicted intents and release
    // their balance locks so the institution's available balance
    // is restored.
    for (const expired of evicted) {
      this.releaseLockFor(expired);
      this.deleteLockRefFor(expired);

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
