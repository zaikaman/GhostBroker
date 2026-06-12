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
  };
}
