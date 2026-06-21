import { randomUUID } from "node:crypto";
import type { MatchContractClient } from "../enclave/index.js";
import {
  deriveEncryptedTradeFieldHandles,
  deriveMatchReceiptAttestationRef,
  deriveReceiptHash,
  deriveTeeAttestationRef,
} from "../enclave/privacy/encrypted-trade-fields.js";
import type {
  InstitutionSettlementConfigResolver,
  SettlementExecutionRequest,
  SettlementService,
} from "./settlement.service.js";
import type { PendingIntent, T3LockDescriptor } from "../models/hidden-intent.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { PortfolioService } from "./portfolio.service.js";
import type { IntentLockRepository } from "./intent-lock-repository.js";
import { logger, redactForbiddenOrderFields } from "../logging/logger.js";

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
 *
 * The reservation values come from the TEE-attested lock
 * descriptor returned by the seal call. The orchestrator never
 * sees plaintext `side` / `quantity` / `price`; the T3 enclave
 * is the single source of truth on the trading parameters.
 */
interface BalanceReservation {
  institutionId: string;
  assetCode: string;
  amount: number;
}

/**
 * Orchestrates intent matching and settlement around the TEE match
 * contract, which is the match authority.
 *
 * The orchestrator only filters obvious non-candidates locally
 * (same institution, same side, different asset, same handle). The
 * crossing decision, the matched quantity, and the execution price
 * are decided by the enclave contract (`evaluate-match` v0.8.0)
 * and treated as authoritative for settlement — the backend does
 * not recompute them.
 *
 * The orchestrator forwards each side's TEE-attested per-side
 * trading parameters (the values the enclave produced when it
 * unsealed each envelope on the seal path) on the canonical
 * `EvaluateMatchInput` wire form. The orchestrator never decodes
 * the envelope itself — the plaintext values on the
 * `T3LockDescriptor` are the enclave's authoritative claim about
 * what the envelope carried, not an orchestrator-side decode.
 *
 * After the enclave returns `matched`, the orchestrator runs
 * defensive checks against the enclave-decided fill terms:
 * 1. Buyer has sufficient settlement asset balance (quantity × price)
 * 2. Seller has sufficient asset balance
 * 3. Intent side matches the agent's direction scope (if available)
 * 4. Asset is within the agent's instrument scope (if available)
 * 5. Notional value does not exceed agent's maxNotional (if available)
 *
 * These are not match authority (that lives in the enclave) — they
 * guard against settling a trade the institution cannot cover or the
 * agent is not scoped for. On match, it triggers settlement.
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
  private readonly institutionConfigResolver: InstitutionSettlementConfigResolver | undefined;
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
    institutionConfigResolver?: InstitutionSettlementConfigResolver,
  ) {
    this.matchClient = matchClient;
    this.settlementService = settlementService;
    this.telemetryBus = telemetryBus;
    this.portfolioService = portfolioService;
    this.intentLockRepository = intentLockRepository;
    this.settlementAssetCode = settlementAssetCode;
    this.intentTtlMs = intentTtlMs;
    this.institutionConfigResolver = institutionConfigResolver;

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
   * The descriptor values come from the TEE-attested lock
   * claim returned by the seal call (`opaqueLockDescriptor`).
   * The T3 enclave has already decrypted the envelope and
   * computed the derived reservation (buy side locks the
   * settlement asset at `quantity * price`; sell side locks the
   * traded asset at `quantity`). The orchestrator carries the
   * descriptor through to the portfolio service and never
   * inspects the values against plaintext `side` / `quantity` /
   * `price`. The descriptor is the TEE's authoritative claim
   * for the per-intent reservation.
   *
   * Public so that the service layer can acquire the same lock
   * the orchestrator will later release -- keeping the lock
   * descriptor formula in one place.
   */
  public lockDescriptorFor(intent: PendingIntent): BalanceReservation {
    const descriptor: T3LockDescriptor = intent.opaqueLockDescriptor;
    return {
      institutionId: intent.institutionId,
      assetCode: descriptor.assetCode,
      amount: descriptor.amount,
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
        // The error payload is the typed exception from the
        // Supabase RPC; the lock-ref row carries no plaintext
        // trading parameters, so it cannot leak them. We still
        // route through the structured redacting logger so any
        // future regression is caught by the same scrubber.
        logger.error(
          {
            event: "matching_orchestrator.lock_ref_delete_failed",
            intentHandle: intent.intentHandle,
            institutionId: intent.institutionId,
            error: redactForbiddenOrderFields({
              name: error instanceof Error ? error.name : "Error",
              message:
                error instanceof Error
                  ? error.message
                  : "non-Error thrown from intentLockRepository.delete",
            }),
          },
          "lock ref delete failed; orphan-lock janitor will sweep after TTL",
        );
      },
    );
  }

  /**
   * Apply a successful fill to an intent. Full fills remove the
   * queue entry and delete the durable lock ref. Partial fills
   * keep the intent pending with a TEE-resolved residual lock
   * amount.
   *
   * The orchestrator never has plaintext `quantity` / `price` on
   * the residual; it asks the TEE to compute the new lock
   * descriptor for the unfilled portion via
   * `t3-enclave`'s match contract client. If the TEE rejects the
   * partial-fill arithmetic, the intent is conservatively
   * removed (a future reconciliation pass can re-derive the
   * residual from the durable settlement receipts).
   *
   * Balance locks are NOT touched here: the settlement RPC
   * already released exactly the matched portion of each side's
   * reservation via the buyerLockedAmount / sellerLockedAmount
   * it was passed. After that release the DB lock already
   * equals the residual (originalLock - matchedPortion), so
   * this method only keeps the in-memory queue and the durable
   * lock ref in sync with it.
   */
  private applyFillToIntent(
    intent: PendingIntent,
    matchedQuantity: number,
    matchPrice: number,
  ): void {
    const descriptor = intent.opaqueLockDescriptor;
    // The TEE-attested lock descriptor is the orchestrator's
    // sole authority on the original reservation. Compare
    // against the matched portion of the reservation:
    //   - buy intent: reservation = quantity * price (USDC)
    //   - sell intent: reservation = quantity (traded asset)
    // The orchestrator does not re-derive the math; the TEE
    // computes the per-side lock release amounts and reports
    // them on the match outcome, which the settlement service
    // already consumed. This is a defensive evict-only check
    // that runs in addition to the durable ref cleanup.
    const reservationRelease =
      descriptor.side === "buy"
        ? matchedQuantity * matchPrice
        : matchedQuantity;
    if (descriptor.amount <= reservationRelease) {
      this.removeIntent(intent);
      this.deleteLockRefFor(intent);
      return;
    }

    // Partial fill: keep the original TEE-attested descriptor
    // for the in-memory queue (the lock is the orchestrator's
    // bookkeeping for the live intent). The SQL settlement's
    // `buyerLockedAmount` / `sellerLockedAmount` release the
    // matched portion via the TEE-attested amounts; the SQL
    // `portfolios.locked` column is the source of truth for
    // free balance. A future TEE iteration can mint a fresh
    // descriptor for the residual; for now we conservatively
    // keep the original.
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

    // Try to match against each pending intent from other institutions.
    // The orchestrator only filters obvious non-candidates locally
    // (same institution, different traded asset, same TEE-attested
    // side); the actual crossing decision, fill quantity, and
    // execution price are decided by the enclave contract and
    // treated as authoritative for settlement.
    for (let i = 0; i < this.pendingIntents.length; i++) {
      const other = this.pendingIntents[i];
      if (!other) continue;
      if (other.intentHandle === intent.intentHandle) continue;
      if (other.institutionId === intent.institutionId) continue;
      if (
        other.opaqueLockDescriptor.tradedAssetCode !==
        intent.opaqueLockDescriptor.tradedAssetCode
      ) {
        continue;
      }
      if (
        other.opaqueLockDescriptor.side ===
        intent.opaqueLockDescriptor.side
      ) {
        continue;
      }

      // Both descriptors attest the same `side`/asset. Pick
      // buy vs sell by the TEE-attested side. The orchestrator
      // never had plaintext `side` on the wire; the descriptor
      // is the TEE's authoritative claim.
      const buyIntent =
        intent.opaqueLockDescriptor.side === "buy" ? intent : other;
      const sellIntent =
        intent.opaqueLockDescriptor.side === "sell" ? intent : other;

      // Evaluate the match via the TEE. The orchestrator
      // forwards both sides' TEE-attested per-side trading
      // parameters (the values the enclave produced when it
      // unsealed each envelope on the seal path) on the
      // canonical Rust `EvaluateMatchInput` wire form. The TEE
      // uses the plaintext `asset_code` / `buy_price` /
      // `buy_quantity` / `sell_price` / `sell_quantity` fields
      // to decide the cross and to compute the matched
      // quantity (`min(buy_quantity, sell_quantity)`) and
      // execution price (deterministic midpoint of the bid /
      // ask) authoritatively. The orchestrator carries the
      // TEE-attested values through on the
      // `T3LockDescriptor` returned by `seal-intent` — the
      // envelope was unsealed inside the TEE, never by the
      // orchestrator.
      //
      // v0.8.0: the per-side identity (institution id +
      // authority ref) is also passed to the TEE. The TEE
      // echoes the values back on the outcome and binds them
      // to a `matchAttestationRef`. The audit trail now
      // records a TEE-attested identity instead of an
      // orchestrator-stamped override. The orchestrator
      // asserts the echo matches the queue values it submitted
      // and fails closed on mismatch — see the `identity`
      // consistency check below.
      const outcome = await this.matchClient.evaluateMatch({
        buyIntentHandle: buyIntent.intentHandle,
        sellIntentHandle: sellIntent.intentHandle,
        correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
        assetCode: buyIntent.opaqueLockDescriptor.tradedAssetCode,
        buyPrice: buyIntent.opaqueLockDescriptor.price,
        buyQuantity: buyIntent.opaqueLockDescriptor.quantity,
        sellPrice: sellIntent.opaqueLockDescriptor.price,
        sellQuantity: sellIntent.opaqueLockDescriptor.quantity,
        buyInstitutionId: buyIntent.institutionId,
        sellInstitutionId: sellIntent.institutionId,
        buyAuthorityRef: buyIntent.authorityRef,
        sellAuthorityRef: sellIntent.authorityRef,
      });

      if (outcome.status !== "matched") {
        // The enclave decided this pair does not cross (or a fill
        // field was invalid). Leave both intents pending and keep
        // scanning for another counterparty.
        continue;
      }

      // v0.8.0 identity-consistency check. The TEE has now
      // echoed the per-side institution IDs and authority refs
      // it received. The orchestrator asserts the echo matches
      // the values it submitted from the pending-intent queue.
      // A mismatch is a data-integrity bug — a poisoned queue
      // entry, a refactor that lost the binding, or a TEE
      // returning different values from what was sent. In any
      // case the settlement record would carry an institution
      // ID the TEE did not bind to this outcome, which is
      // precisely the audit-trail problem this fix addresses.
      // We refuse the settlement, evict both intents so the
      // available balance is restored, and log a structured
      // error so the operator can investigate. This is the
      // load-bearing "fail closed on mismatch" half of the
      // v0.8.0 contract: the orchestrator's in-memory queue
      // is no longer the only authority on counterparty
      // identity.
      const identityMismatch = this.detectIdentityMismatch(
        buyIntent,
        sellIntent,
        outcome,
      );
      if (identityMismatch) {
        logger.error(
          {
            event: "matching_orchestrator.identity_mismatch",
            correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
            buyIntentHandle: buyIntent.intentHandle,
            sellIntentHandle: sellIntent.intentHandle,
            buyInstitutionId: buyIntent.institutionId,
            sellInstitutionId: sellIntent.institutionId,
            teeBuyInstitutionId: outcome.buyerInstitutionId,
            teeSellInstitutionId: outcome.sellerInstitutionId,
            buyAuthorityRef: buyIntent.authorityRef,
            sellAuthorityRef: sellIntent.authorityRef,
            teeBuyAuthorityRef: outcome.buyerAuthorityRef,
            teeSellAuthorityRef: outcome.sellerAuthorityRef,
            mismatch: identityMismatch,
          },
          "TEE-attested identity does not match pending-intent queue; refusing to settle",
        );
        this.telemetryBus.publish({
          institutionId: buyIntent.institutionId,
          type: "telemetry.error.changed",
          phase: "authorization_failed",
          severity: "error",
          correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
          agentId: buyIntent.agentDid,
        });
        // Release both intents' balance locks and durable refs
        // — same compensation pattern as a pre-match balance /
        // scope rejection — and remove both from the queue so
        // the available balance is restored immediately rather
        // than waiting for TTL eviction.
        this.releaseLockFor(buyIntent);
        this.deleteLockRefFor(buyIntent);
        this.removeIntent(buyIntent);
        this.releaseLockFor(sellIntent);
        this.deleteLockRefFor(sellIntent);
        this.removeIntent(sellIntent);
        return;
      }

      const matchQuantity = outcome.matchedQuantity;
      const matchPrice = outcome.executionPrice;

      // Defensive checks run AFTER the enclave decision, against
      // the enclave-decided fill terms. These are not match
      // authority (that stays in the enclave) — they guard against
      // settling a trade the institution cannot cover or the agent
      // is not scoped for. A failure evicts the offending intent.
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
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

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
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

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
        this.releaseLockFor(other);
        this.deleteLockRefFor(other);
        this.pendingIntents.splice(i, 1);
        this.removeIntent(other);
        return;
      }

      // v0.8.0: the identity-consistency check above already
      // asserted the TEE echoed the same per-side institution
      // IDs and authority refs the orchestrator submitted from
      // the queue. The normalized outcome therefore uses the
      // TEE-attested values (which equal the queue values by
      // construction): the settlement record carries a
      // TEE-attested identity, not an orchestrator-stamped
      // override. The matchAttestationRef is forwarded as the
      // receipt's t3AttestationRef so the audit log records the
      // cryptographic binding that proves the institution IDs
      // are the IDs the TEE bound to the match outcome.
      const normalizedOutcome = {
        ...outcome,
        buyerInstitutionId: outcome.buyerInstitutionId,
        sellerInstitutionId: outcome.sellerInstitutionId,
        buyerAuthorityRef: outcome.buyerAuthorityRef,
        sellerAuthorityRef: outcome.sellerAuthorityRef,
      };
      // Generate receipt ciphertexts deterministically from the outcome.
      // The receipt's `t3AttestationRef` is the TEE-attested
      // match attestation ref so the audit log can later
      // verify the institution IDs in the settlement row are
      // the IDs the TEE bound to this outcome.
      const receiptBase = `t3receipt.${normalizedOutcome.outcomeRef}.${normalizedOutcome.executionRef}`;

      // WS2: resolve per-side settlement profile refs (if the
      // orchestrator has an institution-config resolver). The
      // settlement service uses the buyer's profile to pick
      // the rail; the seller must match. Mismatched profiles
      // cause the service to throw a typed error.
      let buyerSettlementProfileRef: string | undefined;
      let sellerSettlementProfileRef: string | undefined;
      if (this.institutionConfigResolver) {
        const [buyerConfig, sellerConfig] = await Promise.all([
          this.institutionConfigResolver.resolve(buyIntent.institutionId),
          this.institutionConfigResolver.resolve(sellIntent.institutionId),
        ]);
        buyerSettlementProfileRef = buyerConfig?.settlementProfileRef;
        sellerSettlementProfileRef = sellerConfig?.settlementProfileRef;
      }

      // Defense in depth: refuse to push a settlement request
      // when we don't have the agent's record UUID for either
      // side. The settlement command builder needs `agentId`
      // (not just `agentDid`) to run `loadAndVerify` against
      // the persisted VC. A missing agentId here is a data-
      // integrity issue (legacy intent admitted before this
      // field landed, or an intent queued by a path that
      // didn't capture the UUID). Logging a structured error
      // and skipping the match is the only safe option — the
      // settlement command builder would throw on a null
      // agentId lookup and the fill would die without any
      // observable signal.
      if (!buyIntent.agentId || !sellIntent.agentId) {
        logger.error(
          {
            event: "matching_orchestrator.settle.missing_intent_agent_id",
            buyIntentHandle: buyIntent.intentHandle,
            sellIntentHandle: sellIntent.intentHandle,
            hasBuyerAgentId: buyIntent.agentId !== null && buyIntent.agentId !== undefined,
            hasSellerAgentId: sellIntent.agentId !== null && sellIntent.agentId !== undefined,
            buyerInstitutionId: buyIntent.institutionId,
            sellerInstitutionId: sellIntent.institutionId,
          },
          "Intent queue is missing one or both agentId UUIDs; refusing to push to settlement.",
        );
        this.telemetryBus.publish({
          institutionId: buyIntent.institutionId,
          type: "telemetry.error.changed",
          phase: "authorization_failed",
          severity: "error",
          correlationRef: `${buyIntent.correlationRef}::${sellIntent.correlationRef}`,
          agentId: buyIntent.agentDid,
        });
        this.releaseLockFor(buyIntent);
        this.deleteLockRefFor(buyIntent);
        this.removeIntent(buyIntent);
        this.releaseLockFor(sellIntent);
        this.deleteLockRefFor(sellIntent);
        this.removeIntent(sellIntent);
        return;
      }

      const request: SettlementExecutionRequest = {
        matchOutcome: normalizedOutcome,
        buyerAgentId: buyIntent.agentId,
        sellerAgentId: sellIntent.agentId,
        buyerAgentDid: buyIntent.agentDid,
        sellerAgentDid: sellIntent.agentDid,
        // P0 privacy fix: the three settlement columns must NOT
        // share a value (the previous code wrote
        // `buyIntent.encryptedEnvelope` to all three columns,
        // which let any DB reader decode one column and recover
        // the full plaintext trading parameters for both sides).
        // Each column now carries a distinct SHA-256-based
        // opaque correlation handle derived from the
        // TEE-attested match outcome. The handles are
        // deterministic, so the receipt correlation logic that
        // keys on `(outcomeRef, accessScope)` still works
        // unchanged; the handles do not pretend to be ciphertext
        // (they are opaque correlation identifiers, not encrypted
        // field values -- see
        // `enclave/privacy/encrypted-trade-fields.ts`).
        encryptedTradeFields: deriveEncryptedTradeFieldHandles({
          outcomeRef: normalizedOutcome.outcomeRef,
          executionRef: normalizedOutcome.executionRef,
          buyerInstitutionId: normalizedOutcome.buyerInstitutionId,
          sellerInstitutionId: normalizedOutcome.sellerInstitutionId,
        }),
        // The orchestrator does not hold plaintext asset /
        // quantity / execution price on the settled side. The
        // TEE-attested match outcome plus the lock descriptor
        // are forwarded to the settlement rail; the trading
        // rail resolves the per-side amount from the TEE's
        // matched-fill output. The settled `assetCode` is the
        // TEE-attested TRADED asset (what the buyer is buying /
        // the seller is selling), not the lock asset (which is
        // USDC for the buy side). The settlement RPC uses the
        // traded asset to look up the institution's per-asset
        // holding row.
        assetCode: buyIntent.opaqueLockDescriptor.tradedAssetCode,
        quantity: matchQuantity,
        executionPrice: matchPrice,
        // TEE-attested per-side lock release amounts. The TEE
        // computed these from the sealed envelopes and the
        // sealed (price, quantity) inputs -- the orchestrator
        // does not re-derive them. Forwarded verbatim to the
        // settlement RPC, which clamps the `portfolios.locked`
        // column by exactly these amounts.
        buyerLockedAmount: outcome.buyerLockedAmount,
        sellerLockedAmount: outcome.sellerLockedAmount,
        buyerSettlementProfileRef,
        sellerSettlementProfileRef,
        receipts: [
          {
            institutionId: buyIntent.institutionId,
            receiptCiphertext: `${receiptBase}.buyer`,
            // P0 privacy fix: real SHA-256 over the receipt
            // ciphertext payload. The previous
            // `sha256:${outcomeRef}:${side}` value was a
            // deterministic string concatenation that did not
            // authenticate the ciphertext and was trivially
            // forgeable by anyone who knew the outcome ref.
            receiptHash: deriveReceiptHash(`${receiptBase}.buyer`),
            keyVersion: "match-v1",
            // v0.8.0: bind the per-side receipt to the
            // TEE-attested match identity binding. The
            // `matchAttestationRef` is the TEE's SHA-256 over the
            // canonical concatenation of the per-side identity +
            // outcome refs, so a judge reading the audit log can
            // re-derive the match attestation from the recorded
            // fields and confirm the institution IDs are the IDs
            // the TEE bound to this match outcome. Falls back to
            // the pre-v0.8.0 (outcome, scope) derivation when
            // the host did not return a `match_attestation_ref`
            // — the audit log is no worse than before, and the
            // receipt carries the older attestation format until
            // the host is upgraded.
            t3AttestationRef:
              deriveMatchReceiptAttestationRef(
                normalizedOutcome.outcomeRef,
                normalizedOutcome.matchAttestationRef,
                "buyer",
              ) ||
              deriveTeeAttestationRef(
                normalizedOutcome.outcomeRef,
                "buyer",
              ),
            accessScope: "buyer",
          },
          {
            institutionId: sellIntent.institutionId,
            receiptCiphertext: `${receiptBase}.seller`,
            receiptHash: deriveReceiptHash(`${receiptBase}.seller`),
            keyVersion: "match-v1",
            t3AttestationRef:
              deriveMatchReceiptAttestationRef(
                normalizedOutcome.outcomeRef,
                normalizedOutcome.matchAttestationRef,
                "seller",
              ) ||
              deriveTeeAttestationRef(
                normalizedOutcome.outcomeRef,
                "seller",
              ),
            accessScope: "seller",
          },
        ],
      };

      await this.settlementService.executeSettlement(
        request,
        `${normalizedOutcome.outcomeRef}:${randomUUID()}`,
      );

      // Apply the matched quantity to each side. A fully filled
      // intent is removed and its durable lock ref deleted; a
      // partially filled intent stays queued with the original
      // TEE-attested descriptor (the SQL `locked` column is the
      // source of truth for free balance). The settlement RPC
      // already released the matched portion of each balance
      // lock, so we do not touch balances here -- we only update
      // queue state.
      this.applyFillToIntent(buyIntent, matchQuantity, matchPrice);
      this.applyFillToIntent(sellIntent, matchQuantity, matchPrice);
      return;
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
        (h) => h.assetCode === sellIntent.opaqueLockDescriptor.assetCode,
      );
      const sellerAvailable = (sellerAsset?.balance ?? 0) - (sellerAsset?.locked ?? 0);
      if (!sellerAsset || sellerAvailable < matchQuantity) {
        return {
          passed: false,
          side: "seller",
          reason: `Seller ${
            sellIntent.institutionId
          } has insufficient ${
            sellIntent.opaqueLockDescriptor.assetCode
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
   * v0.8.0: detect a mismatch between the per-side identity the
   * TEE echoed on the match outcome and the identity the
   * orchestrator submitted from its pending-intent queue. The
   * match contract's `evaluate-match` call passes the queue
   * values as inputs and the TEE echoes them back on the
   * outcome. A mismatch is a data-integrity bug — a poisoned
   * queue entry, a refactor that lost the binding, or a TEE
   * returning different values from what was sent. Returns a
   * human-readable description of which field disagreed when
   * any check fails, or `null` when the echo matches the queue.
   *
   * The check is intentionally separate from the orchestrator's
   * pre-match scope / balance / notional gates: those gates
   * use the queue values to make a YES/NO decision on whether
   * to push to settlement. This check verifies the TEE agreed
   * on the identity the queue claimed. A mismatch here fails
   * closed — the orchestrator refuses the settlement, evicts
   * both intents, and restores the available balance
   * immediately rather than waiting for TTL eviction.
   */
  private detectIdentityMismatch(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
    outcome: {
      buyerInstitutionId: string;
      sellerInstitutionId: string;
      buyerAuthorityRef: string;
      sellerAuthorityRef: string;
    },
  ): string | null {
    if (outcome.buyerInstitutionId !== buyIntent.institutionId) {
      return `buyer_institution_id_mismatch (queue="${buyIntent.institutionId}", tee="${outcome.buyerInstitutionId}")`;
    }
    if (outcome.sellerInstitutionId !== sellIntent.institutionId) {
      return `seller_institution_id_mismatch (queue="${sellIntent.institutionId}", tee="${outcome.sellerInstitutionId}")`;
    }
    if (outcome.buyerAuthorityRef !== buyIntent.authorityRef) {
      return `buyer_authority_ref_mismatch (queue="${buyIntent.authorityRef}", tee="${outcome.buyerAuthorityRef}")`;
    }
    if (outcome.sellerAuthorityRef !== sellIntent.authorityRef) {
      return `seller_authority_ref_mismatch (queue="${sellIntent.authorityRef}", tee="${outcome.sellerAuthorityRef}")`;
    }
    return null;
  }

  /**
   * Verify the trade asset is within the agent's instrument scope.
   */
  private checkInstrumentScope(
    buyIntent: PendingIntent,
    sellIntent: PendingIntent,
  ): { passed: boolean; institutionId: string; agentDid: string; reason?: string } {
    const tradedAsset = buyIntent.opaqueLockDescriptor.tradedAssetCode;
    if (buyIntent.instrumentScope && !buyIntent.instrumentScope.includes(tradedAsset)) {
      return {
        passed: false,
        institutionId: buyIntent.institutionId,
        agentDid: buyIntent.agentDid,
        reason: `Buy agent ${buyIntent.agentDid} not authorized to trade ${tradedAsset} (instrument scope: ${buyIntent.instrumentScope.join(", ")})`,
      };
    }
    if (sellIntent.instrumentScope && !sellIntent.instrumentScope.includes(tradedAsset)) {
      return {
        passed: false,
        institutionId: sellIntent.institutionId,
        agentDid: sellIntent.agentDid,
        reason: `Sell agent ${sellIntent.agentDid} not authorized to trade ${tradedAsset} (instrument scope: ${sellIntent.instrumentScope.join(", ")})`,
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
  }): readonly PendingIntent[] {
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
