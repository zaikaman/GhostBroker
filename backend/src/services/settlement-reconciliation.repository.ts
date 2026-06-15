import { PublicError } from "../errors/public-error.js";
import type { SettlementReconciliationRepository } from "./settlement.service.js";

/**
 * WS4: a thin Supabase implementation of the
 * `SettlementReconciliationRepository`. Reads
 * `completed_trades` rows that have not been reconciled
 * and writes `reconciled_at` after a successful sweep.
 *
 * The reconciler is the only consumer of this repository.
 * The reads are unfiltered (admin-scoped) because the
 * reconciler is a system task, not a per-operator action.
 */
export class SupabaseSettlementReconciliationRepository
  implements SettlementReconciliationRepository
{
  private readonly client: SupabaseReconcilerClient;

  public constructor(client: SupabaseReconcilerClient) {
    this.client = client;
  }

  public async listUnreconciledTrades(
    limit: number,
  ): ReturnType<SettlementReconciliationRepository["listUnreconciledTrades"]> {
    const { data, error } = await this.client
      .from("completed_trades")
      .select(
        "trade_ref,rail_id,rail_trade_ref,buy_institution_id,sell_institution_id,settled_at",
      )
      .eq("rail_state", "settled")
      .is("reconciled_at", null)
      .order("settled_at", { ascending: true })
      .limit(limit);
    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
    // Map DB snake_case to the camelCase the reconciler
    // service consumes. The settlement profile ref is
    // looked up by the orchestrator from the
    // `institutions` table at dispatch time, so the
    // reconciler only needs the row's own rail_id.
    return (data ?? []).map((row) => ({
      tradeRef: row.trade_ref,
      railId: row.rail_id ?? "wallet:default",
      railTradeRef: row.rail_trade_ref ?? "",
      settlementProfileRef: row.rail_id ?? "wallet:default",
      buyerInstitutionId: row.buy_institution_id,
      sellerInstitutionId: row.sell_institution_id,
    }));
  }

  public async markReconciled(
    tradeRef: string,
    observedAt: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("completed_trades")
      .update({ reconciled_at: observedAt })
      .eq("trade_ref", tradeRef);
    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }
}

/**
 * Minimal Supabase client surface used by the reconciler.
 * Matches the shape of `supabase.from('completed_trades')`
 * with the small subset of methods we use. Defined
 * inline because the production wiring in `app.ts` already
 * passes a typed Supabase client.
 */
export interface SupabaseReconcilerClient {
  from(table: "completed_trades"): SupabaseReconcilerQuery;
}

interface SupabaseReconcilerQuery {
  select(
    columns: string,
  ): {
    eq(
      column: string,
      value: string,
    ): {
      is(
        column: string,
        value: null,
      ): {
        order(
          column: string,
          options: { ascending: boolean },
        ): {
          limit(
            rows: number,
          ): Promise<{
            data: ReconcilerTradeRow[] | null;
            error: Error | null;
          }>;
        };
      };
    };
  };
  update(
    values: Record<string, unknown>,
  ): {
    eq(
      column: string,
      value: string,
    ): Promise<{ error: Error | null }>;
  };
}

interface ReconcilerTradeRow {
  trade_ref: string;
  rail_id: string | null;
  rail_trade_ref: string | null;
  buy_institution_id: string;
  sell_institution_id: string;
  settled_at: string;
}
