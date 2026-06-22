import { describe, expect, it } from "vitest";
import type { SettlementCommand } from "../../enclave/index.js";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import {
  MapSettlementRailDispatcher,
} from "../../services/settlement-rails/dispatcher.js";
import type { SettlementRail } from "../../services/settlement-rails/rail.js";
import {
  buildAuditReceiptRecord,
  buildCompletedTradeRecord,
  buildSettlementExecutionRequest,
} from "../data/us3-settlement-builders.js";

/**
 * Settlement telemetry redaction integration test.
 * GhostBroker exposes a single settlement rail
 * (`chain:sepolia:erc20`); this test stubs the rail so
 * it can exercise the persistence + telemetry boundary
 * without spinning up an Anvil chain.
 */
function chainRailStub(): SettlementRail {
  return {
    id: "chain:sepolia:erc20",
    dispatch: async () => ({
      railId: "chain:sepolia:erc20",
      railTradeRef: "0x" + "a".repeat(64),
      railSignerAddress: "0x" + "b".repeat(20),
      railState: "settled",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    }),
    reverse: async (tradeRef) => ({
      railId: "chain:sepolia:erc20",
      railTradeRef: tradeRef,
      railSignerAddress: "0x" + "b".repeat(20),
      railState: "reversed",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    }),
  };
}

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
          completedTrade: buildCompletedTradeRecord({
            rail_id: "chain:sepolia:erc20",
            rail_trade_ref: "0x" + "a".repeat(64),
            rail_state: "settled",
          }),
          receipts: [buildAuditReceiptRecord()],
        }),
      },
      telemetryBus,
      undefined,
      new MapSettlementRailDispatcher(
        new Map([["chain:sepolia:erc20", chainRailStub()]]),
      ),
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
