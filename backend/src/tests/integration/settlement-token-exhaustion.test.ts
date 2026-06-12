import { describe, expect, it } from "vitest";
import {
  InsufficientT3TokenBalanceError,
  type TokenBalance,
} from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { buildSettlementExecutionRequest } from "../data/us3-settlement-builders.js";

describe("settlement token exhaustion", () => {
  it("publishes redacted token metering telemetry", async () => {
    const telemetryBus = new TelemetryBus();
    const phases: string[] = [];
    telemetryBus.subscribe((event) => phases.push(event.phase));
    const balance: TokenBalance = {
      account: "did:t3n:institution:us3",
      available: 0n,
      minimumRequired: 1n,
    };
    const service = new SettlementService(
      {
        build: async () => {
          throw new InsufficientT3TokenBalanceError(balance);
        },
      } as never,
      {
        persistCompletedSettlement: async () => {
          throw new Error("must not persist");
        },
      },
      telemetryBus,
    );

    await expect(
      service.executeSettlement(buildSettlementExecutionRequest(), "corr_us3"),
    ).rejects.toMatchObject({ code: "service_unavailable", statusCode: 503 });
    expect(phases).toContain("token_metering_failed");
  });
});
