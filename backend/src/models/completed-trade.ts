import { z } from "zod";

export const settlementStatusSchema = z.enum(["settled", "failed", "reversed"]);
export type SettlementStatus = z.infer<typeof settlementStatusSchema>;

export const completedTradeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export interface CompletedTrade {
  id: string;
  tradeRef: string;
  assetCodeCiphertext: string;
  quantityCiphertext: string;
  executionPriceCiphertext: string;
  settledAt: string;
  settlementStatus: SettlementStatus;
  receiptIds: string[];
  /**
   * The settlement rail that transported this trade. `null` for
   * pre-WS1 rows (no rail proof existed). For trades settled after
   * WS1, this is the `SettlementRail.id` of the rail that handled
   * the dispatch (e.g. `"chain:sepolia:erc20"` for the Sepolia
   * ERC-20 relayer).
   */
  railId: string | null;
  /**
   * Rail-specific transport proof. A chain tx hash or a
   * `noop:<sha256>` for the legacy noop rail. `null` for pre-WS1
   * rows. GhostBroker exposes only the chain rail; the noop rail
   * has been removed.
   */
  railTradeRef: string | null;
  /**
   * Mirrors `settlementStatus` for symmetry. `null` for pre-WS1
   * rows.
   */
  railState: SettlementStatus | null;
}

export interface CompletedTradeRecord {
  id: string;
  trade_ref: string;
  buy_institution_id: string;
  sell_institution_id: string;
  asset_code_ciphertext: string;
  quantity_ciphertext: string;
  execution_price_ciphertext: string;
  settlement_status: SettlementStatus;
  settled_at: string;
  t3_execution_ref: string;
  /**
   * Optional rail columns. The DB columns are nullable for
   * pre-WS1 rows; the TypeScript fields are `string | null` for
   * the same reason. Both new columns were added in migration
   * `012_completed_trades_rail_columns.sql`.
   */
  rail_id?: string | null;
  rail_trade_ref?: string | null;
  rail_state?: SettlementStatus | null;
  created_at?: string;
}

export function completedTradeFromRecord(
  record: CompletedTradeRecord,
  receiptIds: string[] = [],
): CompletedTrade {
  return {
    id: record.id,
    tradeRef: record.trade_ref,
    assetCodeCiphertext: record.asset_code_ciphertext,
    quantityCiphertext: record.quantity_ciphertext,
    executionPriceCiphertext: record.execution_price_ciphertext,
    settledAt: record.settled_at,
    settlementStatus: record.settlement_status,
    receiptIds,
    railId: record.rail_id ?? null,
    railTradeRef: record.rail_trade_ref ?? null,
    railState: record.rail_state ?? null,
  };
}
