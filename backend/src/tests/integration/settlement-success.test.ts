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
 * WS3 settlement-success integration test. GhostBroker
 * exposes a single settlement rail (`chain:sepolia:erc20`);
 * this test stubs the rail so it can exercise the
 * persistence boundary without spinning up an Anvil chain.
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
          completedTrade: buildCompletedTradeRecord({
            rail_id: "chain:sepolia:erc20",
            rail_trade_ref: "0x" + "a".repeat(64),
            rail_state: "settled",
          }),
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
      undefined,
      undefined,
      new MapSettlementRailDispatcher(
        new Map([["chain:sepolia:erc20", chainRailStub()]]),
      ),
    );

    await expect(
      service.executeSettlement(buildSettlementExecutionRequest(), "corr_us3"),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000341",
      tradeRef: "match_outcome_us3",
      assetCodeCiphertext: "aead.v1:test:asset_us3",
      quantityCiphertext: "aead.v1:test:qty_us3",
      executionPriceCiphertext: "aead.v1:test:price_us3",
      settledAt: "2026-06-12T00:00:00.000Z",
      settlementStatus: "settled",
      // WS1: rail proof fields. The chain-rail stub returns the
      // same rail id + tx hash the fake repository echoed in
      // `completedTrade`.
      railId: "chain:sepolia:erc20",
      railTradeRef: "0x" + "a".repeat(64),
      railState: "settled",
      receiptIds: [
        "00000000-0000-4000-8000-000000000331",
        "00000000-0000-4000-8000-000000000332",
      ],
    });
  });
});
