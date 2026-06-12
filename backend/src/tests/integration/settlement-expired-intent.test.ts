import { describe, expect, it } from "vitest";
import { SettlementExpiredIntentError } from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { buildSettlementExecutionRequest } from "../data/us3-settlement-builders.js";

describe("settlement expired intent", () => {
  it("rejects expired match outcomes before persistence", async () => {
    const service = new SettlementService(
      {
        build: async () => {
          throw new SettlementExpiredIntentError();
        },
      } as never,
      {
        persistCompletedSettlement: async () => {
          throw new Error("must not persist");
        },
      },
      new TelemetryBus(),
    );

    await expect(
      service.executeSettlement(buildSettlementExecutionRequest(), "corr_us3"),
    ).rejects.toMatchObject({ code: "validation_failed", statusCode: 400 });
  });
});
