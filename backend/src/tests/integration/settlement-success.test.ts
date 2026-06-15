import { describe, expect, it } from "vitest";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import {
  buildAuditReceiptRecord,
  buildCompletedTradeRecord,
  buildSettlementExecutionRequest,
} from "../data/us3-settlement-builders.js";

describe("settlement success", () => {
  it("persists completed trade and receipts after command construction", async () => {
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
        persistCompletedSettlement: async () => ({
          completedTrade: buildCompletedTradeRecord(),
          receipts: [
            buildAuditReceiptRecord(),
            buildAuditReceiptRecord({
              id: "00000000-0000-4000-8000-000000000332",
              institution_id: buildSettlementExecutionRequest().matchOutcome
                .sellerInstitutionId,
              access_scope: "seller",
            }),
          ],
        }),
      },
      new TelemetryBus(),
    );

    await expect(
      service.executeSettlement(buildSettlementExecutionRequest(), "corr_us3"),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000341",
      tradeRef: "match_outcome_us3",
      assetCodeCiphertext: "t3cipher.asset.us3",
      quantityCiphertext: "t3cipher.quantity.us3",
      executionPriceCiphertext: "t3cipher.execution.us3",
      settledAt: "2026-06-12T00:00:00.000Z",
      settlementStatus: "settled",
      // WS1: rail proof fields. The fake repository used by this
      // test does not return rail fields, so they default to null.
      // The rail call is verified separately in
      // `settlement-rail-noop.test.ts`.
      railId: null,
      railTradeRef: null,
      railState: null,
      receiptIds: [
        "00000000-0000-4000-8000-000000000331",
        "00000000-0000-4000-8000-000000000332",
      ],
    });
  });
});
