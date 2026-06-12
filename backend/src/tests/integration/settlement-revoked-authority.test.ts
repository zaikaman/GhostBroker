import { describe, expect, it } from "vitest";
import { SettlementAuthorityError } from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { buildSettlementExecutionRequest } from "../data/us3-settlement-builders.js";

describe("settlement revoked authority", () => {
  it("maps authority failure to a redacted authorization error", async () => {
    const service = new SettlementService(
      {
        build: async () => {
          throw new SettlementAuthorityError();
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
    ).rejects.toMatchObject({ code: "authorization_failed", statusCode: 403 });
  });
});
