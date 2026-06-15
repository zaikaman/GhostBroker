import { describe, expect, it } from "vitest";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import {
  MapSettlementRailDispatcher,
  type SettlementRailDispatcher,
} from "../../services/settlement-rails/dispatcher.js";
import { NoopCustodialRail, deriveNoopTradeRef } from "../../services/settlement-rails/noop-custodial-rail.js";
import type { SettlementRail } from "../../services/settlement-rails/rail.js";
import {
  buildAuditReceiptRecord,
  buildCompletedTradeRecord,
  buildSettlementExecutionRequest,
} from "../data/us3-settlement-builders.js";

/**
 * WS1 acceptance tests for the settlement-rails dispatcher.
 *
 * The noop rail is the universal default: every
 * `SettlementProfileRef` the system does not recognise falls
 * through to it. The integration test below asserts:
 *   1. The rail is called exactly once per `executeSettlement`.
 *   2. The rail's proof flows into the `completed_trades` row via
 *      the repository.
 *   3. The proof is also surfaced on the telemetry bus, but
 *      without the proof's `assetMovements` (which would carry
 *      forbidden substrings in the redaction test).
 *   4. The rail is idempotent: a second call with the same
 *      outcome ref returns the same `railTradeRef`.
 *   5. A rail dispatch failure maps to a `service_unavailable`
 *      public error and the trade is not persisted.
 */
describe("settlement rail (WS1 — noop default)", () => {
  it("calls the noop rail and persists the proof on the completed trade", async () => {
    const request = buildSettlementExecutionRequest();
    const expectedRailTradeRef = deriveNoopTradeRef(request.matchOutcome.outcomeRef);

    let persistCalledWithRailProof: unknown = undefined;
    const repository = {
      persistCompletedSettlement: async (value: {
        command: SettlementCommand;
        railProof: { railId: string; railTradeRef: string; railState: "settled" | "failed" | "reversed" };
      }) => {
        persistCalledWithRailProof = value.railProof;
        return {
          completedTrade: buildCompletedTradeRecord({
            rail_id: value.railProof.railId,
            rail_trade_ref: value.railProof.railTradeRef,
            rail_state: value.railProof.railState,
          }),
          receipts: [buildAuditReceiptRecord()],
        };
      },
    };

    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => ({
          commandRef: "settlement_cmd_rail_test",
          outcomeRef: request.matchOutcome.outcomeRef,
          executionRef: request.matchOutcome.executionRef,
          buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
          sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
          encryptedTradeFieldsRef: "encrypted_trade_fields_rail_test",
          submittedAt: "2026-06-12T00:00:00.000Z",
        }),
      } as never,
      repository as never,
      new TelemetryBus(),
    );

    const result = await service.executeSettlement(request, "corr_rail_test");

    // The rail was called and its proof flowed through to persist.
    expect(persistCalledWithRailProof).toEqual({
      railId: "wallet:default",
      railTradeRef: expectedRailTradeRef,
      // WS2.5: the noop rail's `railSignerAddress` is
      // `null` (no on-chain transport).
      railSignerAddress: null,
      railState: "settled",
      assetMovements: [],
      observedAt: expect.any(String) as unknown as string,
    });

    // The completed trade the service returns carries the rail proof.
    expect(result.railId).toBe("wallet:default");
    expect(result.railTradeRef).toBe(expectedRailTradeRef);
    expect(result.railState).toBe("settled");
  });

  it("emits a rail_settled telemetry event with only railId and railTradeRef", async () => {
    const request = buildSettlementExecutionRequest();
    const telemetryBus = new TelemetryBus();
    const seen: string[] = [];
    telemetryBus.subscribe((event) => seen.push(JSON.stringify(event)));

    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => ({
          commandRef: "settlement_cmd_rail_telemetry",
          outcomeRef: request.matchOutcome.outcomeRef,
          executionRef: request.matchOutcome.executionRef,
          buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
          sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
          encryptedTradeFieldsRef: "encrypted_trade_fields_rail_telemetry",
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

    await service.executeSettlement(request, "corr_rail_telemetry");

    const railEvents = seen
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.phase === "rail_settled");

    expect(railEvents).toHaveLength(2); // one per side
    for (const event of railEvents) {
      expect(event.railProofRef).toEqual({
        railId: "wallet:default",
        railTradeRef: deriveNoopTradeRef(request.matchOutcome.outcomeRef),
      });
    }
  });

  it("is idempotent: a second dispatch with the same outcome returns the same railTradeRef", async () => {
    const rail = new NoopCustodialRail();
    const command = {
      commandRef: "settlement_cmd_idempotency",
      outcomeRef: "match_outcome_idempotency",
      executionRef: "t3exec_idempotency",
      buyerInstitutionId: "00000000-0000-4000-8000-000000000901",
      sellerInstitutionId: "00000000-0000-4000-8000-000000000902",
      encryptedTradeFieldsRef: "encrypted_trade_fields_idempotency",
      submittedAt: "2026-06-12T00:00:00.000Z",
    } as const;
    const first = await rail.dispatch(command, {
      assetCode: "WBTC",
      quantity: 1,
      executionPrice: 70000,
    });
    const second = await rail.dispatch(command, {
      assetCode: "WBTC",
      quantity: 1,
      executionPrice: 70000,
    });
    expect(first.railTradeRef).toBe(second.railTradeRef);
    expect(first.railId).toBe(second.railId);
    expect(first.railState).toBe("settled");
  });

  it("falls back to the noop rail for an unknown settlementProfileRef", async () => {
    const dispatcher: SettlementRailDispatcher = new MapSettlementRailDispatcher(
      new Map(),
    );
    const command = {
      commandRef: "settlement_cmd_fallback",
      outcomeRef: "match_outcome_fallback",
      executionRef: "t3exec_fallback",
      buyerInstitutionId: "00000000-0000-4000-8000-000000000911",
      sellerInstitutionId: "00000000-0000-4000-8000-000000000912",
      encryptedTradeFieldsRef: "encrypted_trade_fields_fallback",
      submittedAt: "2026-06-12T00:00:00.000Z",
    } as const;
    const { proof } = await dispatcher.dispatch("not-a-rail-we-know", command, {
      assetCode: "WBTC",
      quantity: 1,
      executionPrice: 70000,
    });
    expect(proof.railId).toBe("wallet:default");
    expect(proof.railState).toBe("settled");
  });

  it("maps a rail dispatch failure to service_unavailable without persisting", async () => {
    const request = buildSettlementExecutionRequest();
    let persistCalled = false;
    const service = new SettlementService(
      {
        build: async (): Promise<SettlementCommand> => ({
          commandRef: "settlement_cmd_rail_fail",
          outcomeRef: request.matchOutcome.outcomeRef,
          executionRef: request.matchOutcome.executionRef,
          buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
          sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
          encryptedTradeFieldsRef: "encrypted_trade_fields_rail_fail",
          submittedAt: "2026-06-12T00:00:00.000Z",
        }),
      } as never,
      {
        persistCompletedSettlement: async () => {
          persistCalled = true;
          throw new Error("must not persist on rail failure");
        },
      },
      new TelemetryBus(),
      undefined,
      undefined,
      new MapSettlementRailDispatcher(
        new Map<string, SettlementRail>([
          [
            "wallet:default",
            {
              id: "wallet:default",
              dispatch: async () => {
                throw new Error("rail transport failed");
              },
              reverse: async () => {
                throw new Error("not implemented");
              },
            },
          ],
        ]),
      ),
    );

    await expect(
      service.executeSettlement(request, "corr_rail_fail"),
    ).rejects.toMatchObject({ code: "service_unavailable", statusCode: 503 });
    expect(persistCalled).toBe(false);
  });
});
