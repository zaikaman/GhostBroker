import { describe, expect, it } from "vitest";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import { PublicError } from "../../errors/public-error.js";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { buildSettlementExecutionRequest } from "../data/us3-settlement-builders.js";

describe("settlement atomicity", () => {
  it("surfaces repository failure without returning a completed trade", async () => {
    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => ({
          commandRef: "settlement_cmd_us3",
          outcomeRef: "match_outcome_us3",
          executionRef: "t3exec_us3",
          buyerInstitutionId: buildSettlementExecutionRequest().matchOutcome
            .buyerInstitutionId,
          sellerInstitutionId: buildSettlementExecutionRequest().matchOutcome
            .sellerInstitutionId,
          encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
          submittedAt: "2026-06-12T00:00:00.000Z",
        }),
      } as never,
      {
        persistCompletedSettlement: async () => {
          throw new PublicError("service_unavailable", 503);
        },
      },
      new TelemetryBus(),
    );

    await expect(
      service.executeSettlement(buildSettlementExecutionRequest(), "corr_us3"),
    ).rejects.toMatchObject({ code: "service_unavailable", statusCode: 503 });
  });

  it("passes exact matched lock amounts into the atomic persistence boundary", async () => {
    const request = buildSettlementExecutionRequest({
      quantity: 12.5,
      executionPrice: 48000,
    });
    let capturedSettlementPlaintext:
      | {
        buyerInstitutionId: string;
        sellerInstitutionId: string;
        assetCode: string;
        quantity: number;
        executionPrice: number;
        buyerLockedAmount: number;
        sellerLockedAmount: number;
      }
      | undefined;

    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => ({
          commandRef: "settlement_cmd_us3",
          outcomeRef: "match_outcome_us3",
          executionRef: "t3exec_us3",
          buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
          sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
          encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
          submittedAt: "2026-06-12T00:00:00.000Z",
        }),
      } as never,
      {
        persistCompletedSettlement: async (value) => {
          capturedSettlementPlaintext = value.settlementPlaintext;
          return {
            completedTrade: {
              id: "00000000-0000-4000-8000-000000000341",
              trade_ref: "match_outcome_us3",
              buy_institution_id: request.matchOutcome.buyerInstitutionId,
              sell_institution_id: request.matchOutcome.sellerInstitutionId,
              asset_code_ciphertext: request.encryptedTradeFields.assetCodeCiphertext,
              quantity_ciphertext: request.encryptedTradeFields.quantityCiphertext,
              execution_price_ciphertext:
                request.encryptedTradeFields.executionPriceCiphertext,
              settlement_status: "settled",
              settled_at: "2026-06-12T00:00:00.000Z",
              t3_execution_ref: "t3exec_us3",
            },
            receipts: [],
          };
        },
      },
      new TelemetryBus(),
    );

    await service.executeSettlement(request, "corr_us3");

    expect(capturedSettlementPlaintext).toEqual({
      buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
      sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
      assetCode: request.assetCode,
      quantity: request.quantity,
      executionPrice: request.executionPrice,
      buyerLockedAmount: request.quantity * request.executionPrice,
      sellerLockedAmount: request.quantity,
    });
  });
});
