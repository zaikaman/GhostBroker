import {
  InsufficientT3TokenBalanceError,
  SettlementAuthorityError,
  SettlementExpiredIntentError,
  type OpaqueMatchOutcome,
  type SettlementCommand,
  type SettlementCommandBuilder,
} from "../enclave/index.js";
import { PublicError } from "../errors/public-error.js";
import { logger } from "../logging/logger.js";
import type { AuditReceiptRecord } from "../models/audit-receipt.js";
import {
  completedTradeFromRecord,
  type CompletedTrade,
  type CompletedTradeRecord,
} from "../models/completed-trade.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { PortfolioService } from "./portfolio.service.js";
import { InsufficientBalanceError } from "./portfolio.service.js";
import {
  MapSettlementRailDispatcher,
  type SettlementRailDispatcher,
} from "./settlement-rails/dispatcher.js";
import { RailDispatchError } from "./settlement-rails/rail-dispatch-error.js";
import type {
  RailSettlementProof,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "./settlement-rails/rail.js";

/**
 * Read a per-institution deposit address from
 * `institutions.metadata.depositAddress`. The metadata is
 * `Record<string, unknown>`; the function is defensive against
 * the field being missing or wrong-typed.
 */
function readDepositAddress(
  metadata: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = metadata["depositAddress"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a per-asset token address map from
 * `institutions.metadata.tokenAddresses`. The field is a
 * `Record<assetCode, address>`. For WS2 both institutions on
 * the same rail use the buyer's map (the rail assumes a single
 * canonical token-address registry per rail). The seller's
 * metadata is consulted as a fallback for any asset missing
 * from the buyer's map.
 */
function readTokenAddresses(
  buyerMetadata: Readonly<Record<string, unknown>>,
  sellerMetadata: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const buyerMap = buyerMetadata["tokenAddresses"];
  if (isStringRecord(buyerMap)) {
    for (const [k, v] of Object.entries(buyerMap)) {
      out[k] = v;
    }
  }
  const sellerMap = sellerMetadata["tokenAddresses"];
  if (isStringRecord(sellerMap)) {
    for (const [k, v] of Object.entries(sellerMap)) {
      if (out[k] === undefined) {
        out[k] = v;
      }
    }
  }
  return out;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "string");
}

/**
 * Per-side settlement profile. The settlement service routes
 * through the dispatcher keyed by this string. GhostBroker
 * exposes a single settlement rail — `chain:sepolia:erc20` —
 * so the only meaningful value is the institution's
 * `settlement_profile_ref` (which must be `chain:sepolia:erc20`
 * per the institution model validation). The dispatcher fails
 * closed with `RailDispatchError` for any other value.
 */
export type SettlementProfileRef = string;

/**
 * WS2: per-institution settlement configuration. The settlement
 * service uses this to resolve the buyer's and seller's
 * `settlement_profile_ref` (which rail to use) and to pass
 * per-institution / per-asset config to the rail's
 * dispatch context.
 *
 * The resolver is the seam between the institution model (where
 * `settlement_profile_ref` and `metadata.depositAddress` live)
 * and the rail layer. Production wiring (`app.ts`) builds an
 * implementation that reads from the `institutions` table via
 * the existing `InstitutionRepository`; tests inject a stub.
 */
export interface InstitutionSettlementConfig {
  settlementProfileRef: string;
  /**
   * Per-institution metadata the rails need. The chain rail
   * reads `depositAddress`; noop rail ignores it.
   */
  metadata: Readonly<Record<string, unknown>>;
}

export interface InstitutionSettlementConfigResolver {
  resolve(institutionId: string): Promise<InstitutionSettlementConfig | null>;
}

/**
 * WS4: the reconciliation DB seam. Defined here (not in
 * `settlement-reconciler.ts`) so the orchestrator's wiring
 * `app.ts` only imports from one module. The reconciler
 * service in `settlement-reconciler.ts` consumes this
 * interface; the Supabase implementation lives in
 * `settlement-reconciliation.repository.ts`.
 */
export interface SettlementReconciliationRepository {
  /**
   * List up to `limit` `completed_trades` rows with
   * `rail_state = 'settled' AND reconciled_at IS NULL`.
   * Ordered by `settled_at ASC` so the oldest
   * unreconciled trade is processed first.
   */
  listUnreconciledTrades(limit: number): Promise<
    {
      tradeRef: string;
      railId: string;
      railTradeRef: string;
      settlementProfileRef: string;
      buyerInstitutionId: string;
      sellerInstitutionId: string;
    }[]
  >;

  /**
   * Mark a trade as reconciled at the given ISO-8601
   * timestamp. Idempotent: a second call with the same
   * `tradeRef` overwrites the previous `reconciled_at`.
   */
  markReconciled(tradeRef: string, observedAt: string): Promise<void>;
}

export interface SettlementExecutionRequest {
  matchOutcome: OpaqueMatchOutcome;
  /**
   * The admitted agent's record UUIDs for both sides. The
   * settlement command builder runs `loadAndVerify` on each
   * side's persisted Ghostbroker delegation VC before issuing
   * the settlement command — the caller never has to send the
   * VC itself.
   */
  buyerAgentId: string;
  sellerAgentId: string;
  buyerAgentDid: string;
  sellerAgentDid: string;
  encryptedTradeFields: {
    assetCodeCiphertext: string;
    quantityCiphertext: string;
    executionPriceCiphertext: string;
  };
  /** Plaintext trade parameters — provided by the TEE match outcome */
  assetCode: string;
  quantity: number;
  executionPrice: number;
  buyerLockedAmount?: number;
  sellerLockedAmount?: number;
  /**
   * WS2: per-side settlement profile. The settlement service
   * looks up the rail via the dispatcher keyed by the buyer's
   * profile. Both sides must be on the same profile for WS2;
   * asymmetric routing is a future concern. GhostBroker exposes
   * a single rail (`chain:sepolia:erc20`), so the resolver
   * returns the buyer's profile or throws if either side has
   * no resolvable profile.
   */
  buyerSettlementProfileRef?: string | undefined;
  sellerSettlementProfileRef?: string | undefined;
  receipts: {
    institutionId: string;
    receiptCiphertext: string;
    receiptHash: string;
    keyVersion: string;
    t3AttestationRef: string;
    accessScope: "buyer" | "seller" | "regulatory_export";
  }[];
}

export interface SettlementPersistenceResult {
  completedTrade: CompletedTradeRecord;
  receipts: AuditReceiptRecord[];
}

export interface SettlementRepository {
  persistCompletedSettlement(value: {
    command: SettlementCommand;
    encryptedTradeFields: SettlementExecutionRequest["encryptedTradeFields"];
    settlementPlaintext: {
      buyerInstitutionId: string;
      sellerInstitutionId: string;
      assetCode: string;
      quantity: number;
      executionPrice: number;
      buyerLockedAmount: number;
      sellerLockedAmount: number;
    };
    receipts: SettlementExecutionRequest["receipts"];
    /**
     * WS1: the rail transport proof produced by
     * `SettlementRail.dispatch(...)`. Both fields are stored on
     * `completed_trades` as `rail_id` and `rail_trade_ref`. The
     * `rail_state` mirrors `settlement_status` and is set to
     * `proof.railState` if the proof is in a terminal state, else
     * `"settled"`.
     */
    railProof: RailSettlementProof;
  }): Promise<SettlementPersistenceResult>;
}

export interface SettlementAuditEvent {
  step: "match" | "settlement" | "balance" | "receipt";
  correlationRef: string;
  executionRef: string;
  institutionIds: string[];
  occurredAt: string;
}

export interface SettlementAuditEventSink {
  emit(event: SettlementAuditEvent): void | Promise<void>;
}

class NoopSettlementAuditEventSink implements SettlementAuditEventSink {
  public emit(): void {
    return undefined;
  }
}

interface RpcQuery<TResult> {
  rpc(
    functionName: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: TResult | null; error: Error | null }>;
}

interface PersistSettlementRpcResult {
  completed_trade: CompletedTradeRecord;
  receipts: AuditReceiptRecord[];
}

export class SupabaseSettlementRepository implements SettlementRepository {
  private readonly client: RpcQuery<PersistSettlementRpcResult>;

  public constructor(client: RpcQuery<PersistSettlementRpcResult>) {
    this.client = client;
  }

  public async persistCompletedSettlement(value: {
    command: SettlementCommand;
    encryptedTradeFields: SettlementExecutionRequest["encryptedTradeFields"];
    settlementPlaintext: {
      buyerInstitutionId: string;
      sellerInstitutionId: string;
      assetCode: string;
      quantity: number;
      executionPrice: number;
      buyerLockedAmount: number;
      sellerLockedAmount: number;
    };
    receipts: SettlementExecutionRequest["receipts"];
    railProof: RailSettlementProof;
  }): Promise<SettlementPersistenceResult> {
    const { data, error } = await this.client.rpc("persist_completed_settlement", {
      completed_trade: {
        trade_ref: value.command.outcomeRef,
        buy_institution_id: value.command.buyerInstitutionId,
        sell_institution_id: value.command.sellerInstitutionId,
        asset_code_ciphertext: value.encryptedTradeFields.assetCodeCiphertext,
        quantity_ciphertext: value.encryptedTradeFields.quantityCiphertext,
        execution_price_ciphertext:
          value.encryptedTradeFields.executionPriceCiphertext,
        settlement_status: "settled",
        settled_at: value.command.submittedAt,
        t3_execution_ref: value.command.executionRef,
        rail_id: value.railProof.railId,
        rail_trade_ref: value.railProof.railTradeRef,
        rail_state: value.railProof.railState,
      },
      receipts: value.receipts.map((receipt) => ({
        institution_id: receipt.institutionId,
        receipt_ciphertext: receipt.receiptCiphertext,
        receipt_hash: receipt.receiptHash,
        key_version: receipt.keyVersion,
        t3_attestation_ref: receipt.t3AttestationRef,
        access_scope: receipt.accessScope,
      })),
      settlement_plaintext: {
        buyer_institution_id: value.settlementPlaintext.buyerInstitutionId,
        seller_institution_id: value.settlementPlaintext.sellerInstitutionId,
        asset_code: value.settlementPlaintext.assetCode,
        quantity: value.settlementPlaintext.quantity,
        execution_price: value.settlementPlaintext.executionPrice,
        buyer_locked_amount: value.settlementPlaintext.buyerLockedAmount,
        seller_locked_amount: value.settlementPlaintext.sellerLockedAmount,
      },
    });

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return {
      completedTrade: data.completed_trade,
      receipts: data.receipts,
    };
  }
}

export class SettlementService {
  private readonly commandBuilder: SettlementCommandBuilder;
  private readonly repository: SettlementRepository;
  private readonly telemetryBus: TelemetryBus;
  private readonly auditEvents: SettlementAuditEventSink;
  private readonly portfolioService: PortfolioService | undefined;
  /**
   * WS1: rail dispatcher. Defaults to a noop-only dispatcher so
   * existing unit tests that construct `SettlementService`
   * with 3-5 args continue to work unchanged. Production wiring
   * (`app.ts`) passes an explicit dispatcher.
   */
  private readonly railDispatcher: SettlementRailDispatcher;
  /**
   * WS2: per-institution config lookup. Used to resolve the
   * per-institution `settlement_profile_ref`, the per-institution
   * deposit address (chain rail), and the per-asset token address
   * (chain rail) at dispatch time. Optional: when absent, the
   * service falls back to the noop rail's hard-coded default and
   * any per-side profile is ignored.
   */
  private readonly institutionConfigResolver: InstitutionSettlementConfigResolver | undefined;

  public constructor(
    commandBuilder: SettlementCommandBuilder,
    repository: SettlementRepository,
    telemetryBus: TelemetryBus,
    auditEvents: SettlementAuditEventSink = new NoopSettlementAuditEventSink(),
    portfolioService?: PortfolioService,
    railDispatcher?: SettlementRailDispatcher,
    institutionConfigResolver?: InstitutionSettlementConfigResolver,
  ) {
    this.commandBuilder = commandBuilder;
    this.repository = repository;
    this.telemetryBus = telemetryBus;
    this.auditEvents = auditEvents;
    this.portfolioService = portfolioService;
    this.railDispatcher = railDispatcher ?? new MapSettlementRailDispatcher(new Map());
    this.institutionConfigResolver = institutionConfigResolver;
  }

  public async executeSettlement(
    request: SettlementExecutionRequest,
    correlationRef: string,
  ): Promise<CompletedTrade> {
    let settlementProfileRef: SettlementProfileRef | undefined;
    let railProof: RailSettlementProof | undefined;
    this.publish(
      request.matchOutcome.buyerInstitutionId,
      "settlement_pending",
      correlationRef,
    );
    this.publish(
      request.matchOutcome.sellerInstitutionId,
      "settlement_pending",
      correlationRef,
    );

    try {
      const command = await this.commandBuilder.build({
        matchOutcome: request.matchOutcome,
        buyerAgentId: request.buyerAgentId,
        sellerAgentId: request.sellerAgentId,
        buyerAgentDid: request.buyerAgentDid,
        sellerAgentDid: request.sellerAgentDid,
      });
      await this.emitAudit("match", command, correlationRef);

      // WS1/WS2: rail dispatch sits between the TEE command build
      // and the DB persist. On rail failure: no DB write, no
      // portfolio delta, the orchestrator's existing cancellation
      // path releases the locked balance.
      //
      // The settlement profile is the buyer's
      // `institutions.settlement_profile_ref` (when the orchestrator
      // plumbed it through). Both sides must be on the same
      // profile for WS2; asymmetric routing is a WS3+ concern.
      // If the request does not carry a per-side profile (e.g.
      // legacy callers) or the institution lookup is absent
      // (test paths), the service falls back to the noop rail's
      // hard-coded default.
      settlementProfileRef =
        (await this.resolveEffectiveProfile(
          request.buyerSettlementProfileRef,
          request.sellerSettlementProfileRef,
          request.matchOutcome.buyerInstitutionId,
          request.matchOutcome.sellerInstitutionId,
        )) ?? "chain:sepolia:erc20";
      const plaintext: SettlementRailPlaintext = {
        assetCode: request.assetCode,
        quantity: request.quantity,
        executionPrice: request.executionPrice,
      };
      const railContext = await this.buildRailContext(
        request.matchOutcome.buyerInstitutionId,
        request.matchOutcome.sellerInstitutionId,
        request.assetCode,
      );
      // WS4: track rail dispatch latency so the
      // `rail_settled` telemetry event can graph p50 / p99.
      const railDispatchStartedAt = Date.now();
      const { proof } = await this.railDispatcher.dispatch(
        settlementProfileRef,
        command,
        plaintext,
        railContext,
      );
      railProof = proof;
      const railLatencyMs = Date.now() - railDispatchStartedAt;
      this.publishRailSettled(
        request.matchOutcome.buyerInstitutionId,
        proof,
        correlationRef,
        railLatencyMs,
      );
      this.publishRailSettled(
        request.matchOutcome.sellerInstitutionId,
        proof,
        correlationRef,
        railLatencyMs,
      );

      const persisted = await this.repository.persistCompletedSettlement({
        command,
        encryptedTradeFields: request.encryptedTradeFields,
          settlementPlaintext: {
            buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
            sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
            assetCode: request.assetCode,
            quantity: request.quantity,
            executionPrice: request.executionPrice,
            buyerLockedAmount:
              request.buyerLockedAmount ??
              request.quantity * request.executionPrice,
            sellerLockedAmount:
              request.sellerLockedAmount ?? request.quantity,
          },
          receipts: request.receipts,
          railProof: proof,
        });
      await this.emitAudit("settlement", command, correlationRef);

      // Portfolio mutation now happens inside the settlement persistence RPC.
      if (this.portfolioService) {
        // Notify both institutions that their portfolio has been updated
        this.telemetryBus.publish({
          institutionId: request.matchOutcome.buyerInstitutionId,
          type: "telemetry.portfolio.changed",
          phase: "portfolio_updated",
          severity: "info",
          correlationRef,
        });
        this.telemetryBus.publish({
          institutionId: request.matchOutcome.sellerInstitutionId,
          type: "telemetry.portfolio.changed",
          phase: "portfolio_updated",
          severity: "info",
          correlationRef,
        });
      }

      await this.emitAudit("balance", command, correlationRef);
      await this.emitAudit("receipt", command, correlationRef);
      const receiptIds = persisted.receipts.map((receipt) => receipt.id);

      this.publish(
        request.matchOutcome.buyerInstitutionId,
        "settlement_finalized",
        correlationRef,
      );
      this.publish(
        request.matchOutcome.sellerInstitutionId,
        "settlement_finalized",
        correlationRef,
      );

      for (const receipt of persisted.receipts) {
        this.telemetryBus.publish({
          institutionId: receipt.institution_id,
          type: "telemetry.processing.changed",
          phase: "receipt_available",
          severity: "info",
          correlationRef,
          receiptRef: receipt.id,
        });
      }

      return completedTradeFromRecord(persisted.completedTrade, receiptIds);
    } catch (error) {
      // Diagnostic: surface the exact error type, name, message, and
      // cause so operators can distinguish between a Supabase RPC
      // failure, a chain rail RPC timeout, a missing deposit address,
      // or any other underlying issue. The structured logger carries
      // the full error chain. Remove this once the root cause is stable.
      //
      // The `error.cause` can be a Supabase RPC error object (not an
      // Error instance). Pino's structured serializer handles nested
      // objects safely (including circular references), so we pass the
      // cause object directly rather than pre-stringifying it —
      // otherwise the log would have a double-encoded JSON string.
      // If the cause has a `.message` field (common for Supabase RPC
      // errors), we use that directly as the most readable signal.
      const causeForLog =
        error instanceof Error && error.cause !== undefined
          ? typeof error.cause === "object" && error.cause !== null
            ? ((error.cause as { message?: unknown }).message ??
                error.cause)
            : String(error.cause)
          : undefined;
      logger.error(
        {
          event: "settlement.execute_settlement_failed",
          errorType:
            error !== null && typeof error === "object"
              ? (error as { name?: unknown }).name ?? typeof error
              : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorCause: causeForLog,
          settlementProfileRef,
          hasRailProof: railProof !== undefined,
          correlationRef,
        },
        "executeSettlement failed; diagnostic details in structured log.",
      );

      if (settlementProfileRef && railProof) {
        await this.compensateRailDispatch(
          settlementProfileRef,
          railProof,
          request.matchOutcome.buyerInstitutionId,
          request.matchOutcome.sellerInstitutionId,
          correlationRef,
        );
      }
      this.publishFailure(request, correlationRef, error);
      throw this.toPublicSettlementError(error);
    }
  }

  private publish(
    institutionId: string,
    phase:
      | "settlement_pending"
      | "settlement_finalized"
      | "settlement_failed"
      | "authorization_failed"
      | "token_metering_failed",
    correlationRef: string,
  ): void {
    this.telemetryBus.publish({
      institutionId,
      type: phase.endsWith("_failed")
        ? "telemetry.error.changed"
        : "telemetry.processing.changed",
      phase,
      severity: phase.endsWith("_failed") ? "error" : "info",
      correlationRef,
    });
  }

  /**
   * WS1: emit a `rail_settled` telemetry event. Carries only the
   * rail id and the rail-specific transport ref. The full
   * `RailSettlementProof` (with its `assetMovements`) is never
   * published on the telemetry bus — see the type-level comment
   * on `TelemetryEvent.railProofRef` for the rationale.
   */
  private publishRailSettled(
    institutionId: string,
    proof: RailSettlementProof,
    correlationRef: string,
    latencyMs?: number,
  ): void {
    this.telemetryBus.publish({
      institutionId,
      type: "telemetry.processing.changed",
      phase: "rail_settled",
      severity: "info",
      correlationRef,
      railProofRef: {
        railId: proof.railId,
        railTradeRef: proof.railTradeRef,
      },
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    });
  }

  private publishRailReversed(
    institutionId: string,
    proof: RailSettlementProof,
    correlationRef: string,
  ): void {
    this.telemetryBus.publish({
      institutionId,
      type: "telemetry.processing.changed",
      phase: "rail_reversed",
      severity: "warning",
      correlationRef,
      railProofRef: {
        railId: proof.railId,
        railTradeRef: proof.railTradeRef,
      },
    });
  }

  private async emitAudit(
    step: SettlementAuditEvent["step"],
    command: SettlementCommand,
    correlationRef: string,
  ): Promise<void> {
    await this.auditEvents.emit({
      step,
      correlationRef,
      executionRef: command.executionRef,
      institutionIds: [command.buyerInstitutionId, command.sellerInstitutionId],
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * WS2: resolve the effective settlement profile. The buyer's
   * profile is the dispatch key (the seller must match). If
   * either side is missing a profile (legacy callers, or
   * resolver absent), the function returns `null` and the
   * caller falls back to the noop rail's hard-coded default.
   *
   * Mismatched profiles return `null` too: WS2 does not
   * support asymmetric routing. The caller must reject the
   * trade before this is reached (the orchestrator is
   * responsible for that check).
   */
  private async resolveEffectiveProfile(
    buyerProfile: string | undefined,
    sellerProfile: string | undefined,
    buyerInstitutionId: string,
    sellerInstitutionId: string,
  ): Promise<string | null> {
    if (!this.institutionConfigResolver) {
      return null;
    }
    if (buyerProfile && sellerProfile) {
      if (buyerProfile !== sellerProfile) {
        throw new Error(
          `Settlement profile mismatch: buyer (${buyerInstitutionId}) is on '${buyerProfile}' but seller (${sellerInstitutionId}) is on '${sellerProfile}'. WS2 requires both sides on the same profile.`,
        );
      }
      return buyerProfile;
    }
    const [buyerConfig, sellerConfig] = await Promise.all([
      this.institutionConfigResolver.resolve(buyerInstitutionId),
      this.institutionConfigResolver.resolve(sellerInstitutionId),
    ]);
    if (!buyerConfig || !sellerConfig) {
      return null;
    }
    if (buyerConfig.settlementProfileRef !== sellerConfig.settlementProfileRef) {
      throw new Error(
        `Settlement profile mismatch: buyer (${buyerInstitutionId}) is on '${buyerConfig.settlementProfileRef}' but seller (${sellerInstitutionId}) is on '${sellerConfig.settlementProfileRef}'. WS2 requires both sides on the same profile.`,
      );
    }
    return buyerConfig.settlementProfileRef;
  }

  /**
   * WS2: build the rail dispatch context. Reads the
   * per-institution deposit addresses and the per-asset token
   * addresses from the institution metadata. Returns
   * `undefined` if either institution cannot be resolved
   * (the chain rail will then fail at dispatch time with a
   * typed error).
   */
  private async buildRailContext(
    buyerInstitutionId: string,
    sellerInstitutionId: string,
    assetCode: string,
  ): Promise<SettlementRailContext | undefined> {
    if (!this.institutionConfigResolver) {
      return undefined;
    }
    const [buyerConfig, sellerConfig] = await Promise.all([
      this.institutionConfigResolver.resolve(buyerInstitutionId),
      this.institutionConfigResolver.resolve(sellerInstitutionId),
    ]);
    if (!buyerConfig || !sellerConfig) {
      return undefined;
    }
    const depositAddresses: Record<string, string> = {};
    const buyerDeposit = readDepositAddress(buyerConfig.metadata);
    const sellerDeposit = readDepositAddress(sellerConfig.metadata);
    if (buyerDeposit) {
      depositAddresses[buyerInstitutionId] = buyerDeposit;
    }
    if (sellerDeposit) {
      depositAddresses[sellerInstitutionId] = sellerDeposit;
    }
    const tokenAddresses = readTokenAddresses(buyerConfig.metadata, sellerConfig.metadata);
    return {
      depositAddresses,
      tokenAddresses,
      buyerProfileRef: buyerConfig.settlementProfileRef,
      sellerProfileRef: sellerConfig.settlementProfileRef,
    };
    // Note: `assetCode` is passed in so a future iteration can
    // fall back to the per-institution `metadata.tokenAddresses[assetCode]`
    // when the buyer and seller do not share a token-address
    // map. For WS2 both institutions on the same rail use the
    // same token-address map.
    void assetCode;
  }

  private publishFailure(
    request: SettlementExecutionRequest,
    correlationRef: string,
    error: unknown,
  ): void {
    const phase =
      error instanceof InsufficientT3TokenBalanceError
        ? "token_metering_failed"
        : error instanceof SettlementAuthorityError ||
            error instanceof InsufficientBalanceError ||
            (error instanceof PublicError && error.code === "authorization_failed")
          ? "authorization_failed"
          : "settlement_failed";

    this.publish(request.matchOutcome.buyerInstitutionId, phase, correlationRef);
    this.publish(request.matchOutcome.sellerInstitutionId, phase, correlationRef);
  }

  private async compensateRailDispatch(
    settlementProfileRef: string,
    proof: RailSettlementProof,
    buyerInstitutionId: string,
    sellerInstitutionId: string,
    correlationRef: string,
  ): Promise<void> {
    try {
      const reversed = await this.railDispatcher
        .resolve(settlementProfileRef)
        .reverse(proof.railTradeRef, "post_dispatch_persist_failure");
      this.publishRailReversed(buyerInstitutionId, reversed, correlationRef);
      this.publishRailReversed(sellerInstitutionId, reversed, correlationRef);
    } catch (reverseError) {
      logger.error(
        {
          err: reverseError,
          railTradeRef: proof.railTradeRef,
          buyerInstitutionId,
          sellerInstitutionId,
          correlationRef,
          event: "settlement.rail_compensation_failed",
        },
        "Failed to compensate rail dispatch; manual intervention required.",
      );
    }
  }

  private toPublicSettlementError(error: unknown): PublicError {
    if (error instanceof PublicError) {
      return error;
    }

    if (error instanceof SettlementAuthorityError) {
      return new PublicError("authorization_failed", 403);
    }

    if (error instanceof SettlementExpiredIntentError) {
      return new PublicError("validation_failed", 400);
    }

    if (error instanceof InsufficientT3TokenBalanceError) {
      return new PublicError("service_unavailable", 503);
    }

    if (error instanceof InsufficientBalanceError) {
      return new PublicError("authorization_failed", 403);
    }

    if (error instanceof RailDispatchError) {
      // A rail failure is a transport-layer problem (chain RPC
      // unreachable, relayer rejected, custody API error). It is
      // not an authorization failure — the agent's credentials are
      // valid, the TEE command built successfully. The right
      // status is 503 service_unavailable so the orchestrator's
      // retry path can pick it up.
      return new PublicError("service_unavailable", 503);
    }

    return new PublicError("service_unavailable", 503);
  }

}

