import { PublicError } from "../errors/public-error.js";
import {
  completedTradeFromRecord,
  type CompletedTrade,
  type CompletedTradeRecord,
} from "../models/completed-trade.js";
import type { AuditReceiptRecord } from "../models/audit-receipt.js";

type QueryResult<TResult> = {
  data: TResult[] | null;
  error: Error | null;
};

interface SelectQuery<TResult> extends PromiseLike<QueryResult<TResult>> {
  or(expression: string): SelectQuery<TResult>;
  gte(column: string, value: string): SelectQuery<TResult>;
  lte(column: string, value: string): SelectQuery<TResult>;
  in(column: string, values: readonly string[]): SelectQuery<TResult>;
  order(column: string, options: { ascending: boolean }): SelectQuery<TResult>;
  eq(column: string, value: string): SelectQuery<TResult>;
}

interface TableQuery<TResult> {
  select(columns?: string): SelectQuery<TResult>;
}

export interface TradeHistoryRepository {
  listCompletedTrades(
    institutionId: string,
    filter?: { from?: string; to?: string },
  ): Promise<CompletedTrade[]>;
  /**
   * WS4.2: look up a single completed trade by its
   * `trade_ref`, scoped to the operator's institution. The
   * repository's Supabase implementation filters by
   * `buy_institution_id` OR `sell_institution_id`, so an
   * operator from either side of the trade can fetch it.
   * Returns `null` when no such trade exists.
   *
   * Optional on the interface because test fakes that
   * only exercise the list path do not implement it.
   * Production implementations must provide it; the
   * admin reverser route assumes it is present.
   */
  getCompletedTradeByRef?(
    institutionId: string,
    tradeRef: string,
  ): Promise<CompletedTrade | null>;
}

export interface SupabaseTradeHistoryClient {
  from(table: "completed_trades"): TableQuery<CompletedTradeRecord>;
  from(table: "audit_receipts"): TableQuery<AuditReceiptRecord>;
}

export class SupabaseTradeHistoryRepository implements TradeHistoryRepository {
  private readonly client: SupabaseTradeHistoryClient;

  public constructor(client: SupabaseTradeHistoryClient) {
    this.client = client;
  }

  public async listCompletedTrades(
    institutionId: string,
    filter: { from?: string; to?: string } = {},
  ): Promise<CompletedTrade[]> {
    let query = this.client
      .from("completed_trades")
      .select("*")
      .or(
        `buy_institution_id.eq.${institutionId},sell_institution_id.eq.${institutionId}`,
      );

    if (filter.from) {
      query = query.gte("settled_at", filter.from);
    }

    if (filter.to) {
      query = query.lte("settled_at", filter.to);
    }

    const { data, error } = await query.order("settled_at", {
      ascending: false,
    });

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    const tradeIds = new Set(data.map((trade) => trade.id));
    const receiptIdsByTradeId = new Map<string, string[]>();
    if (tradeIds.size === 0) {
      return [];
    }
    const { data: receiptRows, error: receiptError } = await this.client
      .from("audit_receipts")
      .select("id,completed_trade_id")
      .in("completed_trade_id", Array.from(tradeIds))
      .eq("institution_id", institutionId);

    if (receiptError || !receiptRows) {
      throw new PublicError("service_unavailable", 503, receiptError);
    }

    for (const receipt of receiptRows) {
      const receiptIds = receiptIdsByTradeId.get(receipt.completed_trade_id) ?? [];
      receiptIds.push(receipt.id);
      receiptIdsByTradeId.set(receipt.completed_trade_id, receiptIds);
    }

    return data.map((record) =>
      completedTradeFromRecord(record, receiptIdsByTradeId.get(record.id) ?? []),
    );
  }

  public async getCompletedTradeByRef(
    institutionId: string,
    tradeRef: string,
  ): Promise<CompletedTrade | null> {
    const { data, error } = await this.client
      .from("completed_trades")
      .select("*")
      .or(
        `buy_institution_id.eq.${institutionId},sell_institution_id.eq.${institutionId}`,
      )
      .eq("trade_ref", tradeRef)
      .order("settled_at", { ascending: false });
    const record = data?.[0];
    if (error || !record) {
      return null;
    }
    return completedTradeFromRecord(record);
  }
}

export class TradeHistoryService {
  private readonly repository: TradeHistoryRepository;

  public constructor(repository: TradeHistoryRepository) {
    this.repository = repository;
  }

  public async listCompletedTrades(
    institutionId: string,
    filter?: { from?: string; to?: string },
  ): Promise<{ items: CompletedTrade[] }> {
    const items = await this.repository.listCompletedTrades(institutionId, filter);
    return { items };
  }

  public async getCompletedTradeByRef(
    institutionId: string,
    tradeRef: string,
  ): Promise<CompletedTrade | null> {
    if (!this.repository.getCompletedTradeByRef) {
      throw new PublicError(
        "service_unavailable",
        503,
        "Repository does not implement getCompletedTradeByRef",
      );
    }
    return this.repository.getCompletedTradeByRef(institutionId, tradeRef);
  }
}
