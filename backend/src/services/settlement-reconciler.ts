import { PublicError } from "../errors/public-error.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { SettlementRailDispatcher } from "./settlement-rails/dispatcher.js";

/**
 * WS4: a row in `completed_trades` that is eligible for
 * reconciliation. The reconciler queries the DB for
 * `rail_state = 'settled' AND reconciled_at IS NULL` and
 * processes one row at a time.
 */
export interface ReconcilerTradeRow {
  tradeRef: string;
  railId: string;
  railTradeRef: string;
  settlementProfileRef: string;
  buyerInstitutionId: string;
  sellerInstitutionId: string;
}

export interface ReconcilerDb {
  /**
   * List trade rows that have not yet been reconciled.
   * Returns at most `limit` rows.
   */
  listUnreconciledTrades(limit: number): Promise<ReconcilerTradeRow[]>;

  /**
   * Mark a trade as reconciled at the given ISO-8601
   * timestamp. The reconciler writes the same value for
   * every successful reconciliation; on drift, the
   * reconciler also writes a sentinel that the
   * `next reconciliation` sweep can use to back off.
   */
  markReconciled(tradeRef: string, observedAt: string): Promise<void>;
}

/**
 * WS4: a tiny extension to the `SettlementRail` contract
 * for status checks. The noop rail returns a synthetic
 * "settled" status (it has no external transport to check);
 * the chain rail reads the chain receipt. WS4 extends
 * the rail's surface with a `status(tradeRef)` method.
 */
export interface RailStatusChecker {
  status(
    railTradeRef: string,
  ): Promise<{ railState: "settled" | "missing" | "reverted"; observedAt: string }>;
}

/**
 * WS4: the reconciler service. Periodically (every 10
 * minutes in production, configurable for tests) queries
 * the DB for trades that have not yet been reconciled,
 * looks up the rail that produced each, calls
 * `rail.status(railTradeRef)` to read the rail's view of
 * the trade's state, and updates the DB row's
 * `reconciled_at` (or fires a high-severity telemetry
 * event on drift).
 *
 * Drift detection:
 *   - The DB says `settled`; the rail says `settled` →
 *     mark reconciled.
 *   - The DB says `settled`; the rail says `missing`
 *     (chain reorg, tx dropped, mempool eviction) →
 *     emit a high-severity telemetry event so ops can
 *     investigate. The DB row's `reconciled_at` is set
 *     anyway so the reconciler does not loop on the
 *     same drift forever.
 *   - The DB says `settled`; the rail says `reverted`
 *     (the on-chain `transferFrom` pair failed) →
 *     same as missing.
 *
 * The reconciler is intentionally conservative: it never
 * flips the DB row's `settlement_status` to `failed` on
 * its own. The reverser (WS4.2) is the only path that
 * can change `settlement_status`. The reconciler's job
 * is to surface drift, not to remediate it.
 */
export class SettlementReconciler {
  private readonly db: ReconcilerDb;
  private readonly railDispatcher: SettlementRailDispatcher;
  private readonly telemetryBus: TelemetryBus;
  private readonly batchSize: number;
  private readonly telemetryPhase = "rail_reconciled";

  public constructor(
    db: ReconcilerDb,
    railDispatcher: SettlementRailDispatcher,
    telemetryBus: TelemetryBus,
    batchSize = 50,
  ) {
    this.db = db;
    this.railDispatcher = railDispatcher;
    this.telemetryBus = telemetryBus;
    this.batchSize = batchSize;
  }

  /**
   * Run one reconciliation sweep. Returns the number of
   * rows processed. Production calls this on a 10-minute
   * timer; tests call it directly with a small batch size.
   */
  public async runOnce(): Promise<number> {
    const rows = await this.db.listUnreconciledTrades(this.batchSize);
    let processed = 0;
    for (const row of rows) {
      await this.reconcileRow(row);
      processed += 1;
    }
    return processed;
  }

  private async reconcileRow(row: ReconcilerTradeRow): Promise<void> {
    const rail = this.railDispatcher.resolve(row.settlementProfileRef);
    if (!this.railSupportsStatus(rail)) {
      // The rail does not implement `status` (e.g. a
      // future custody rail). Mark as reconciled with
      // the rail's static view (always "settled" for
      // rails that don't speak status). The reconciler
      // does not error; the rail's own reverse path
      // is the only way to flip a row's state.
      await this.db.markReconciled(row.tradeRef, new Date().toISOString());
      return;
    }
    try {
      const status = await rail.status(row.railTradeRef);
      if (status.railState === "settled") {
        await this.db.markReconciled(row.tradeRef, status.observedAt);
        this.telemetryBus.publish({
          institutionId: row.buyerInstitutionId,
          type: "telemetry.processing.changed",
          phase: this.telemetryPhase,
          severity: "info",
          correlationRef: row.tradeRef,
          railProofRef: {
            railId: row.railId,
            railTradeRef: row.railTradeRef,
          },
        });
        return;
      }
      // Drift: the rail's view disagrees with the DB.
      // Emit a high-severity telemetry event so ops
      // can investigate. Mark the row as reconciled
      // anyway so the reconciler does not loop on
      // the same drift forever; the reverser (WS4.2)
      // is the only path that can change the row's
      // status.
      await this.db.markReconciled(row.tradeRef, status.observedAt);
      this.telemetryBus.publish({
        institutionId: row.buyerInstitutionId,
        type: "telemetry.error.changed",
        phase: "rail_drift_detected",
        severity: "error",
        correlationRef: row.tradeRef,
        railProofRef: {
          railId: row.railId,
          railTradeRef: row.railTradeRef,
        },
      });
    } catch (cause) {
      // The rail threw (e.g. RPC unreachable). Do NOT
      // mark the row as reconciled; the next sweep
      // will retry.
      this.telemetryBus.publish({
        institutionId: row.buyerInstitutionId,
        type: "telemetry.error.changed",
        phase: "rail_reconcile_error",
        severity: "error",
        correlationRef: row.tradeRef,
        railProofRef: {
          railId: row.railId,
          railTradeRef: row.railTradeRef,
        },
      });
      // Re-throw so the timer's caller knows the sweep
      // is incomplete; production should log and
      // continue. We re-throw here to keep the
      // contract honest for tests.
      throw new PublicError(
        "service_unavailable",
        503,
        `Settlement reconciler failed for trade ${row.tradeRef}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /**
   * Narrow type guard: returns `true` when the rail
   * exposes a `status(tradeRef)` method. The noop rail
   * does not (its docs say "settled" is unconditional).
   */
  private railSupportsStatus(rail: unknown): rail is RailStatusChecker {
    return (
      typeof rail === "object" &&
      rail !== null &&
      "status" in rail &&
      typeof (rail as { status: unknown }).status === "function"
    );
  }
}
