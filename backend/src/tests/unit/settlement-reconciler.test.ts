import { describe, expect, it, vi } from "vitest";
import { SettlementReconciler } from "../../services/settlement-reconciler.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import {
  MapSettlementRailDispatcher,
} from "../../services/settlement-rails/dispatcher.js";
import type {
  ReconcilerDb,
  ReconcilerTradeRow,
} from "../../services/settlement-reconciler.js";
import type { TelemetryEvent } from "../../websocket/telemetry-event.js";

/**
 * WS4.1: reconciler unit tests. The reconciler is a
 * system task that:
 *   1. Queries the DB for unreconciled rows.
 *   2. Calls `rail.status(railTradeRef)` on the rail
 *      that produced the original settlement.
 *   3. Marks the row as reconciled.
 *   4. Emits a `rail_reconciled` telemetry event on
 *      success.
 *   5. Emits a `rail_drift_detected` high-severity
 *      telemetry event on mismatch.
 *
 * Tests use a fake rail (with a `status` method) and
 * a fake DB. They do not exercise Anvil.
 *
 * GhostBroker exposes a single settlement rail
 * (`chain:sepolia:erc20`); the reconciler only exercises
 * the chain rail.
 */

function makeDb(rows: ReconcilerTradeRow[], reconciled: string[] = []): ReconcilerDb & {
  listCalls: number;
  markCalls: { tradeRef: string; observedAt: string }[];
} {
  const markCalls: { tradeRef: string; observedAt: string }[] = [];
  const reconciledSet = new Set(reconciled);
  return {
    listCalls: 0,
    markCalls,
    async listUnreconciledTrades(limit: number) {
      this.listCalls += 1;
      return rows
        .filter((r) => !reconciledSet.has(r.tradeRef))
        .slice(0, limit);
    },
    async markReconciled(tradeRef: string, observedAt: string) {
      markCalls.push({ tradeRef, observedAt });
    },
  };
}

function makeTradeRow(overrides: Partial<ReconcilerTradeRow> = {}): ReconcilerTradeRow {
  return {
    tradeRef: "match_outcome_recon_1",
    railId: "chain:sepolia:erc20",
    railTradeRef: "0xabc",
    settlementProfileRef: "chain:sepolia:erc20",
    buyerInstitutionId: "00000000-0000-4000-8000-000000000e01",
    sellerInstitutionId: "00000000-0000-4000-8000-000000000e02",
    ...overrides,
  };
}

describe("SettlementReconciler (WS4)", () => {
  it("marks a chain-rail row as reconciled and emits rail_reconciled when status is 'settled'", async () => {
    const telemetryBus = new TelemetryBus();
    const events: TelemetryEvent[] = [];
    telemetryBus.subscribe((e) => events.push(e));

    const settledRail = {
      id: "chain:sepolia:erc20",
      dispatch: vi.fn(),
      reverse: vi.fn(),
      status: vi.fn().mockResolvedValue({
        railState: "settled",
        observedAt: "2026-06-12T00:00:00.000Z",
      }),
    };
    const railDispatcher = new MapSettlementRailDispatcher(
      new Map<string, never>([
        ["chain:sepolia:erc20", settledRail as never],
      ]),
    );
    const db = makeDb([makeTradeRow({ railTradeRef: "0xdeadbeef" })]);
    const reconciler = new SettlementReconciler(db, railDispatcher, telemetryBus);

    const processed = await reconciler.runOnce();
    expect(processed).toBe(1);
    expect(db.markCalls).toHaveLength(1);
    expect(db.markCalls[0]?.tradeRef).toBe("match_outcome_recon_1");
    expect(settledRail.status).toHaveBeenCalledWith("0xdeadbeef");
    const reconEvents = events.filter((e) => e.phase === "rail_reconciled");
    expect(reconEvents).toHaveLength(1);
  });

  it("emits rail_drift_detected when the rail says 'missing'", async () => {
    const telemetryBus = new TelemetryBus();
    const events: TelemetryEvent[] = [];
    telemetryBus.subscribe((e) => events.push(e));

    const driftedRail = {
      id: "chain:sepolia:erc20",
      dispatch: vi.fn(),
      reverse: vi.fn(),
      status: vi.fn().mockResolvedValue({
        railState: "missing",
        observedAt: "2026-06-12T00:00:00.000Z",
      }),
    };
    const railDispatcher = new MapSettlementRailDispatcher(
      new Map<string, never>([
        ["chain:sepolia:erc20", driftedRail as never],
      ]),
    );
    const db = makeDb([
      makeTradeRow({ railTradeRef: "0xmissing" }),
    ]);
    const reconciler = new SettlementReconciler(db, railDispatcher, telemetryBus);

    const processed = await reconciler.runOnce();
    expect(processed).toBe(1);
    // The row is still marked as reconciled (so the
    // next sweep does not loop on the same drift)…
    expect(db.markCalls).toHaveLength(1);
    // …but a high-severity drift event is emitted.
    const driftEvents = events.filter((e) => e.phase === "rail_drift_detected");
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]?.severity).toBe("error");
  });

  it("does NOT mark the row as reconciled when the rail throws (next sweep retries)", async () => {
    const telemetryBus = new TelemetryBus();
    const events: TelemetryEvent[] = [];
    telemetryBus.subscribe((e) => events.push(e));

    const failingRail = {
      id: "chain:sepolia:erc20",
      dispatch: vi.fn(),
      reverse: vi.fn(),
      status: vi.fn().mockRejectedValue(new Error("RPC unreachable")),
    };
    const railDispatcher = new MapSettlementRailDispatcher(
      new Map<string, never>([
        ["chain:sepolia:erc20", failingRail as never],
      ]),
    );
    const db = makeDb([
      makeTradeRow({ railTradeRef: "0xfailing" }),
    ]);
    const reconciler = new SettlementReconciler(db, railDispatcher, telemetryBus);

    // The reconciler wraps the rail's error in a
    // PublicError("service_unavailable", 503). The
    // inner cause is the rail's original error.
    await expect(reconciler.runOnce()).rejects.toMatchObject({
      code: "service_unavailable",
      statusCode: 503,
    });
    // No markReconciled call (the row stays unreconciled).
    expect(db.markCalls).toHaveLength(0);
    // A rail_reconcile_error telemetry event fires.
    const errorEvents = events.filter((e) => e.phase === "rail_reconcile_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.severity).toBe("error");
  });

  it("processes up to batchSize rows per sweep", async () => {
    const telemetryBus = new TelemetryBus();
    const settledRail = {
      id: "chain:sepolia:erc20",
      dispatch: vi.fn(),
      reverse: vi.fn(),
      status: vi.fn().mockResolvedValue({
        railState: "settled",
        observedAt: "2026-06-12T00:00:00.000Z",
      }),
    };
    const railDispatcher = new MapSettlementRailDispatcher(
      new Map<string, never>([
        ["chain:sepolia:erc20", settledRail as never],
      ]),
    );
    const db = makeDb([
      makeTradeRow({ tradeRef: "t1" }),
      makeTradeRow({ tradeRef: "t2" }),
      makeTradeRow({ tradeRef: "t3" }),
    ]);
    const reconciler = new SettlementReconciler(db, railDispatcher, telemetryBus, 2);

    const processed = await reconciler.runOnce();
    expect(processed).toBe(2);
    expect(db.markCalls).toHaveLength(2);
  });
});
