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
});
