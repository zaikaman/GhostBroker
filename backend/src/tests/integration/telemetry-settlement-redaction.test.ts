import { describe, expect, it } from "vitest";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import {
  buildAuditReceiptRecord,
  buildCompletedTradeRecord,
  buildSettlementExecutionRequest,
} from "../data/us3-settlement-builders.js";

describe("settlement telemetry redaction", () => {
  it("emits settlement phases without plaintext trade fields", async () => {
    const telemetryBus = new TelemetryBus();
    const payloads: string[] = [];
    telemetryBus.subscribe((event) => payloads.push(JSON.stringify(event)));
    const request = buildSettlementExecutionRequest();
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
        persistCompletedSettlement: async () => ({
          completedTrade: buildCompletedTradeRecord(),
          receipts: [buildAuditReceiptRecord()],
        }),
      },
      telemetryBus,
    );

    await service.executeSettlement(request, "corr_us3");

    expect(payloads.join("\n")).toMatch(/settlement_pending/u);
    expect(payloads.join("\n")).toMatch(/settlement_finalized/u);
    expect(payloads.join("\n")).toMatch(/receipt_available/u);
    expect(payloads.join("\n")).not.toMatch(
      /asset|side|quantity|price|counterparty|queue|plaintext/iu,
    );
  });
});
