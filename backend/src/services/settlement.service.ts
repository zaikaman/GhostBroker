import {
  InsufficientT3TokenBalanceError,
  SettlementAuthorityError,
  SettlementExpiredIntentError,
  type OpaqueMatchOutcome,
  type SettlementCommand,
  type SettlementCommandBuilder,
} from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";
import type { AuditReceiptRecord } from "../models/audit-receipt.js";
import {
  completedTradeFromRecord,
  type CompletedTrade,
  type CompletedTradeRecord,
} from "../models/completed-trade.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { PortfolioService } from "./portfolio.service.js";
import { InsufficientBalanceError } from "./portfolio.service.js";

export interface SettlementExecutionRequest {
  matchOutcome: OpaqueMatchOutcome;
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
    receipts: SettlementExecutionRequest["receipts"];
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
    receipts: SettlementExecutionRequest["receipts"];
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
      },
      receipts: value.receipts.map((receipt) => ({
        institution_id: receipt.institutionId,
        receipt_ciphertext: receipt.receiptCiphertext,
        receipt_hash: receipt.receiptHash,
        key_version: receipt.keyVersion,
        t3_attestation_ref: receipt.t3AttestationRef,
        access_scope: receipt.accessScope,
      })),
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

  public constructor(
    commandBuilder: SettlementCommandBuilder,
    repository: SettlementRepository,
    telemetryBus: TelemetryBus,
    auditEvents: SettlementAuditEventSink = new NoopSettlementAuditEventSink(),
    portfolioService?: PortfolioService,
  ) {
    this.commandBuilder = commandBuilder;
    this.repository = repository;
    this.telemetryBus = telemetryBus;
    this.auditEvents = auditEvents;
    this.portfolioService = portfolioService;
  }

  public async executeSettlement(
    request: SettlementExecutionRequest,
    correlationRef: string,
  ): Promise<CompletedTrade> {
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
        buyerAgentDid: request.buyerAgentDid,
        sellerAgentDid: request.sellerAgentDid,
      });
      await this.emitAudit("match", command, correlationRef);
      const persisted = await this.repository.persistCompletedSettlement({
        command,
        encryptedTradeFields: request.encryptedTradeFields,
        receipts: request.receipts,
      });
      await this.emitAudit("settlement", command, correlationRef);

      // Update portfolio balances with plaintext trade params from TEE
      if (this.portfolioService) {
        await this.portfolioService.applySettlement({
          buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
          sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
          assetCode: request.assetCode,
          quantity: request.quantity,
          price: request.executionPrice,
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

  private publishFailure(
    request: SettlementExecutionRequest,
    correlationRef: string,
    error: unknown,
  ): void {
    const phase =
      error instanceof InsufficientT3TokenBalanceError
        ? "token_metering_failed"
        : error instanceof SettlementAuthorityError ||
            error instanceof InsufficientBalanceError
          ? "authorization_failed"
          : "settlement_failed";

    this.publish(request.matchOutcome.buyerInstitutionId, phase, correlationRef);
    this.publish(request.matchOutcome.sellerInstitutionId, phase, correlationRef);
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

    return new PublicError("service_unavailable", 503);
  }

}

