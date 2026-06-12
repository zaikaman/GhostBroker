import { PublicError } from "../errors/public-error.js";
import {
  completedTradeFromRecord,
  type CompletedTrade,
  type CompletedTradeRecord,
} from "../models/completed-trade.js";
import type { AuditReceiptRecord } from "../models/audit-receipt.js";

interface SelectQuery<TResult> {
  or(expression: string): SelectQuery<TResult>;
  gte(column: string, value: string): SelectQuery<TResult>;
  lte(column: string, value: string): SelectQuery<TResult>;
  order(column: string, options: { ascending: boolean }): Promise<{
    data: TResult[] | null;
    error: Error | null;
  }>;
  eq(column: string, value: string): Promise<{
    data: TResult[] | null;
    error: Error | null;
  }>;
}

interface TableQuery<TResult> {
  select(columns?: string): SelectQuery<TResult>;
}

export interface TradeHistoryRepository {
  listCompletedTrades(
    institutionId: string,
    filter?: { from?: string; to?: string },
  ): Promise<CompletedTrade[]>;
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
    const receiptsResult = await this.client
      .from("audit_receipts")
      .select("id,completed_trade_id")
      .eq("institution_id", institutionId);

    if (receiptsResult.error || !receiptsResult.data) {
      throw new PublicError("service_unavailable", 503, receiptsResult.error);
    }

    for (const receipt of receiptsResult.data) {
      if (tradeIds.has(receipt.completed_trade_id)) {
        const receiptIds = receiptIdsByTradeId.get(receipt.completed_trade_id) ?? [];
        receiptIds.push(receipt.id);
        receiptIdsByTradeId.set(receipt.completed_trade_id, receiptIds);
      }
    }

    return data.map((record) =>
      completedTradeFromRecord(record, receiptIdsByTradeId.get(record.id) ?? []),
    );
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
}
