import { z } from "zod";

export const portfolioEntrySchema = z.object({
  assetCode: z.string().trim().min(1).max(20),
  balance: z.number().nonnegative(),
  locked: z.number().nonnegative(),
});

export type PortfolioEntry = z.infer<typeof portfolioEntrySchema>;

export interface PortfolioRecord {
  id: string;
  institution_id: string;
  asset_code: string;
  balance: string; // numeric from postgres
  locked: string;
  created_at?: string;
  updated_at?: string;
}

export interface Portfolio {
  institutionId: string;
  holdings: {
    assetCode: string;
    balance: number;
    locked: number;
  }[];
}

export interface PortfolioSnapshotHolding {
  assetCode: string;
  balance: number;
}

export const portfolioSnapshotHoldingSchema = z.object({
  assetCode: z.string().trim().min(1).max(20).toUpperCase(),
  balance: z.number().nonnegative(),
});

export const portfolioSnapshotSyncRequestSchema = z.object({
  sourceRef: z.string().trim().min(1).max(256).optional(),
  observedAt: z.string().datetime().optional(),
  holdings: z.array(portfolioSnapshotHoldingSchema),
});

export type PortfolioSnapshotSyncRequest = z.infer<
  typeof portfolioSnapshotSyncRequestSchema
>;

export function portfolioFromRecords(
  records: PortfolioRecord[],
): Portfolio {
  if (records.length === 0) {
    return { institutionId: "", holdings: [] };
  }
  return {
    institutionId: records[0]!.institution_id,
    holdings: records.map((r) => ({
      assetCode: r.asset_code,
      balance: Number.parseFloat(r.balance),
      locked: Number.parseFloat(r.locked),
    })),
  };
}

export interface PortfolioAdjustment {
  institutionId: string;
  assetCode: string;
  delta: number; // positive = credit, negative = debit
}

export const portfolioAdjustmentSchema = z.object({
  institutionId: z.string().uuid(),
  assetCode: z.string().trim().min(1).max(20),
  delta: z.number().finite(),
});

export type PortfolioHistoryChangeType =
  | "settlement_buy"
  | "settlement_sell"
  | "adjustment"
  | "import";

export interface PortfolioHistoryRecord {
  id: string;
  institution_id: string;
  asset_code: string;
  delta: string;
  balance_after: string;
  change_type: PortfolioHistoryChangeType;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface PortfolioHistoryEntry {
  id: string;
  institutionId: string;
  assetCode: string;
  delta: number;
  balanceAfter: number;
  changeType: PortfolioHistoryChangeType;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

export function portfolioHistoryFromRecord(
  record: PortfolioHistoryRecord,
): PortfolioHistoryEntry {
  return {
    id: record.id,
    institutionId: record.institution_id,
    assetCode: record.asset_code,
    delta: Number.parseFloat(record.delta),
    balanceAfter: Number.parseFloat(record.balance_after),
    changeType: record.change_type,
    referenceType: record.reference_type,
    referenceId: record.reference_id,
    createdAt: record.created_at,
  };
}
