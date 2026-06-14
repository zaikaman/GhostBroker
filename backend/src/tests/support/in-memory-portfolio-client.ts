import type { PortfolioRecord } from "../../models/portfolio.js";

export interface PortfolioRpcCall {
  functionName: string;
  parameters: Readonly<Record<string, unknown>>;
}

function cloneRecord(record: PortfolioRecord): PortfolioRecord {
  return { ...record };
}

function compareRecordIds(a: PortfolioRecord, b: PortfolioRecord): number {
  return a.asset_code.localeCompare(b.asset_code);
}

export function makePortfolioRecord(params: {
  institutionId: string;
  assetCode: string;
  balance: number;
  locked?: number;
  id?: string;
}): PortfolioRecord {
  return {
    id: params.id ?? `${params.institutionId}:${params.assetCode}`,
    institution_id: params.institutionId,
    asset_code: params.assetCode,
    balance: params.balance.toString(),
    locked: (params.locked ?? 0).toString(),
  };
}

export class InMemoryPortfolioClient {
  public readonly portfolios: PortfolioRecord[];
  public readonly historyInserts: Array<Record<string, unknown>> = [];
  public readonly rpcCalls: PortfolioRpcCall[] = [];

  public constructor(portfolios: PortfolioRecord[] = []) {
    this.portfolios = portfolios.map(cloneRecord);
  }

  public from(table: "portfolios" | "portfolio_history") {
    if (table === "portfolios") {
      return {
        select: () => ({
          eq: (column: string, value: string) => ({
            order: async (orderColumn: string, options?: { ascending?: boolean }) => {
              const filtered = this.portfolios.filter((record) => {
                if (column === "institution_id") {
                  return record.institution_id === value;
                }
                return (
                  record as unknown as Record<string, string | undefined>
                )[column] === value;
              });
              const sorted = [...filtered].sort(compareRecordIds);
              if (orderColumn === "asset_code" && options?.ascending === false) {
                sorted.reverse();
              }
              return { data: sorted, error: null };
            },
          }),
        }),
      };
    }

    return {
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [], error: null }),
        }),
        not: () => ({
          order: async () => ({ data: [], error: null }),
        }),
      }),
      insert: async (values: Record<string, unknown>) => {
        this.historyInserts.push(values);
        return { error: null };
      },
    };
  }

  public async rpc(
    functionName: string,
    parameters: Record<string, unknown> = {},
  ): Promise<{ data: null; error: Error | null }> {
    this.rpcCalls.push({ functionName, parameters });

    const institutionId = String(parameters.p_institution_id ?? "");
    const assetCode = String(parameters.p_asset_code ?? "").toUpperCase();

    if (functionName === "portfolio_update_balance") {
      const delta = Number(parameters.p_delta ?? 0);
      this.applyDelta(institutionId, assetCode, delta);
      return { data: null, error: null };
    }

    if (functionName === "portfolio_sync_balance") {
      const balance = Number(parameters.p_balance ?? 0);
      this.applyAbsolute(institutionId, assetCode, balance);
      return { data: null, error: null };
    }

    if (functionName === "portfolio_lock_balance") {
      const amount = Number(parameters.p_amount ?? 0);
      const result = this.applyLock(institutionId, assetCode, amount);
      if (result) {
        return result;
      }
      return { data: null, error: null };
    }

    if (functionName === "portfolio_release_balance") {
      const amount = Number(parameters.p_amount ?? 0);
      this.applyRelease(institutionId, assetCode, amount);
      return { data: null, error: null };
    }

    return {
      data: null,
      error: new Error(`Unexpected RPC: ${functionName}`),
    };
  }

  private applyDelta(
    institutionId: string,
    assetCode: string,
    delta: number,
  ): void {
    const existing = this.portfolios.find(
      (record) =>
        record.institution_id === institutionId && record.asset_code === assetCode,
    );

    const balance = existing ? Number(existing.balance) : 0;
    const locked = existing ? Number(existing.locked) : 0;
    const nextBalance = Math.max(balance + delta, 0);
    const nextLocked = Math.min(locked, nextBalance);

    if (existing) {
      existing.balance = nextBalance.toString();
      existing.locked = nextLocked.toString();
      return;
    }

    this.portfolios.push({
      id: `${institutionId}:${assetCode}`,
      institution_id: institutionId,
      asset_code: assetCode,
      balance: nextBalance.toString(),
      locked: nextLocked.toString(),
    });
  }

  private applyAbsolute(
    institutionId: string,
    assetCode: string,
    balance: number,
  ): void {
    const existing = this.portfolios.find(
      (record) =>
        record.institution_id === institutionId && record.asset_code === assetCode,
    );

    const nextBalance = Math.max(balance, 0);
    const nextLocked = existing ? Math.min(Number(existing.locked), nextBalance) : 0;

    if (existing) {
      existing.balance = nextBalance.toString();
      existing.locked = nextLocked.toString();
      return;
    }

    this.portfolios.push({
      id: `${institutionId}:${assetCode}`,
      institution_id: institutionId,
      asset_code: assetCode,
      balance: nextBalance.toString(),
      locked: nextLocked.toString(),
    });
  }

  /**
   * Apply a lock increment. Returns an error result if available
   * balance is insufficient. Otherwise, atomically increments
   * `locked` and returns null.
   */
  private applyLock(
    institutionId: string,
    assetCode: string,
    amount: number,
  ): { data: null; error: Error } | null {
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        data: null,
        error: new Error(`lock amount must be positive, got ${amount}`),
      };
    }

    let record = this.portfolios.find(
      (r) =>
        r.institution_id === institutionId && r.asset_code === assetCode,
    );

    if (!record) {
      record = {
        id: `${institutionId}:${assetCode}`,
        institution_id: institutionId,
        asset_code: assetCode,
        balance: "0",
        locked: "0",
      };
      this.portfolios.push(record);
    }

    const balance = Number(record.balance);
    const locked = Number(record.locked);
    const available = balance - locked;

    if (available < amount) {
      return {
        data: null,
        error: new Error(
          `insufficient available balance for ${assetCode}: requested ${amount}, available ${available}`,
        ),
      };
    }

    record.locked = (locked + amount).toString();
    return null;
  }

  private applyRelease(
    institutionId: string,
    assetCode: string,
    amount: number,
  ): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const record = this.portfolios.find(
      (r) =>
        r.institution_id === institutionId && r.asset_code === assetCode,
    );

    if (!record) {
      return;
    }

    const locked = Number(record.locked);
    record.locked = Math.max(locked - amount, 0).toString();
  }
}
