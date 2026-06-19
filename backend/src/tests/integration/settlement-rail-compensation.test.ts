import { describe, expect, it } from "vitest";
import type {
  RailSettlementProof,
  SettlementRail,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "../../services/settlement-rails/rail.js";
import { MapSettlementRailDispatcher } from "../../services/settlement-rails/dispatcher.js";
import type { SettlementCommand } from "../../enclave/index.js";
import { PublicError } from "../../errors/public-error.js";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { buildSettlementExecutionRequest } from "../data/us3-settlement-builders.js";

/**
 * Regression: when the settlement rail has already moved assets
 * (the chain transfer succeeded) but the durable DB persist then
 * fails, the service must compensate by reversing the rail
 * dispatch. Otherwise funds move on-chain while GhostBroker has
 * no completed_trades row and the intents are still pending.
 */
class RecordingRail implements SettlementRail {
  public readonly id = "chain:test:erc20";
  public dispatched = 0;
  public reversed: { tradeRef: string; reason: string }[] = [];

  public async dispatch(
    command: SettlementCommand,
    _plaintext: SettlementRailPlaintext,
    _context?: SettlementRailContext,
  ): Promise<RailSettlementProof> {
    this.dispatched += 1;
    return {
      railId: this.id,
      railTradeRef: `0xtx_${command.outcomeRef}`,
      railSignerAddress: "0xrelayer",
      railState: "settled",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    };
  }

  public async reverse(
    tradeRef: string,
    reason: string,
  ): Promise<RailSettlementProof> {
    this.reversed.push({ tradeRef, reason });
    return {
      railId: this.id,
      railTradeRef: tradeRef,
      railSignerAddress: "0xrelayer",
      railState: "reversed",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    };
  }
}

function buildCommand(): SettlementCommand {
  const request = buildSettlementExecutionRequest();
  return {
    commandRef: "settlement_cmd_comp",
    outcomeRef: "match_outcome_comp",
    executionRef: "t3exec_comp",
    buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
    sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
    encryptedTradeFieldsRef: "encrypted_trade_fields_comp",
    submittedAt: "2026-06-12T00:00:00.000Z",
  };
}

describe("settlement rail compensation", () => {
  it("reverses the rail dispatch when DB persist fails after assets moved", async () => {
    const rail = new RecordingRail();
    const dispatcher = new MapSettlementRailDispatcher(
      new Map<string, SettlementRail>([[rail.id, rail]]),
    );

    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => buildCommand(),
      } as never,
      {
        persistCompletedSettlement: async () => {
          throw new PublicError("service_unavailable", 503);
        },
      },
      new TelemetryBus(),
      undefined,
      undefined,
      dispatcher,
      {
        resolve: async () => ({
          settlementProfileRef: rail.id,
          metadata: {},
        }),
      },
    );

    const request = buildSettlementExecutionRequest({
      buyerSettlementProfileRef: rail.id,
      sellerSettlementProfileRef: rail.id,
    });

    await expect(service.executeSettlement(request, "corr_comp")).rejects.toMatchObject({
      code: "service_unavailable",
    });

    // The rail moved assets exactly once, and the failed persist
    // triggered exactly one compensating reverse for that tx.
    expect(rail.dispatched).toBe(1);
    expect(rail.reversed).toHaveLength(1);
    expect(rail.reversed[0]?.tradeRef).toBe("0xtx_match_outcome_comp");
  });
});
