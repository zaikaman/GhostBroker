import { PublicError } from "../errors/public-error.js";
import {
  portfolioFromRecords,
  portfolioHistoryFromRecord,
  type Portfolio,
  type PortfolioAdjustment,
  type PortfolioSnapshotHolding,
  type PortfolioRecord,
  type PortfolioHistoryEntry,
  type PortfolioHistoryRecord,
  type PortfolioHistoryChangeType,
} from "../models/portfolio.js";

interface RpcQuery<TResult> {
  rpc(
    functionName: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: TResult | null; error: Error | null }>;
}

interface SelectQuery<TResult> {
  select(columns?: string): {
    eq(column: string, value: string): {
      order(column: string, options?: { ascending?: boolean }): Promise<{
        data: TResult[] | null;
        error: Error | null;
      }>;
    };
  };
}

interface SelectQueryWithMultiEq<TResult> {
  select(columns?: string): {
    eq(column: string, value: string): {
      order(column: string, options?: { ascending?: boolean }): Promise<{
        data: TResult[] | null;
        error: Error | null;
      }>;
    };
    not(column: string, operator: string, value: string): {
      order(column: string, options?: { ascending?: boolean }): Promise<{
        data: TResult[] | null;
        error: Error | null;
      }>;
    };
  };
}

interface InsertQuery {
  insert(
    values: Record<string, unknown>,
  ): Promise<{ error: Error | null }>;
}

interface InsertQueryWithSelect<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): Promise<{ data: TResult[] | null; error: Error | null }>;
  };
}

export interface SupabasePortfolioClient {
  from(table: "portfolios"): SelectQuery<PortfolioRecord> & InsertQuery;
  from(table: "portfolio_history"): SelectQueryWithMultiEq<PortfolioHistoryRecord> &
    InsertQueryWithSelect<PortfolioHistoryRecord>;
}

/**
 * Minimum absolute delta (in token units) required to record a history entry
 * during portfolio snapshot sync. Changes smaller than this threshold are
 * considered dust / wei-level noise and are silently skipped.
 */
const MINIMUM_HISTORY_DELTA = 1e-8;

export class InsufficientBalanceError extends Error {
  public readonly assetCode: string;
  public readonly requested: number;
  public readonly available: number;

  public constructor(assetCode: string, requested: number, available: number) {
    super(
      `Insufficient ${assetCode} balance: requested ${requested}, available ${available}`,
    );
    this.name = "InsufficientBalanceError";
    this.assetCode = assetCode;
    this.requested = requested;
    this.available = available;
  }
}

export class PortfolioService {
  private readonly client: SupabasePortfolioClient;
  private readonly settlementAssetCode: string;

  public constructor(
    client: SupabasePortfolioClient,
    settlementAssetCode = "USDC",
  ) {
    this.client = client;
    this.settlementAssetCode = settlementAssetCode.trim().toUpperCase();
  }

  public async getPortfolio(institutionId: string): Promise<Portfolio> {
    const { data, error } = await this.client
      .from("portfolios")
      .select("*")
      .eq("institution_id", institutionId)
      .order("asset_code", { ascending: true });

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return portfolioFromRecords(data ?? []);
  }

  /**
   * Atomically apply a list of balance adjustments.
   * All adjustments are applied in order within a single RPC call.
   * Returns the updated portfolio.
   */
  public async applyAdjustments(
    adjustments: PortfolioAdjustment[],
  ): Promise<Portfolio> {
    if (adjustments.length === 0) {
      throw new PublicError("validation_failed", 400);
    }

    const institutionId = adjustments[0]!.institutionId;

    // Verify all adjustments belong to the same institution
    for (const adj of adjustments) {
      if (adj.institutionId !== institutionId) {
        throw new PublicError("validation_failed", 400);
      }
    }

    // Apply each adjustment via the portfolio_update_balance RPC
    for (const adj of adjustments) {
      // Fetch current balance before update for history tracking
      const before = await this.getPortfolio(institutionId);
      const currentBalance =
        before.holdings.find((h) => h.assetCode === adj.assetCode)?.balance ?? 0;

      const { error } = await (this.client as unknown as RpcQuery<undefined>).rpc(
        "portfolio_update_balance",
        {
          p_institution_id: adj.institutionId,
          p_asset_code: adj.assetCode,
          p_delta: adj.delta.toString(),
        },
      );

      if (error) {
        if (error.message?.includes("insufficient balance")) {
          throw new InsufficientBalanceError(
            adj.assetCode,
            Math.abs(adj.delta),
            0,
          );
        }
        throw new PublicError("service_unavailable", 503, error);
      }

      // Record history entry
      const balanceAfter = Math.max(0, currentBalance + adj.delta);
      await this.recordHistory({
        institutionId: adj.institutionId,
        assetCode: adj.assetCode,
        delta: adj.delta,
        balanceAfter,
        changeType: "adjustment",
      });
    }

    return this.getPortfolio(institutionId);
  }

  /**
   * Apply settlement adjustments for both buyer and seller atomically.
   * Buyer: cash decreases (-price * qty), asset increases (+qty)
   * Seller: asset decreases (-qty), cash increases (+price * qty)
   */
  public async applySettlement(params: {
    buyerInstitutionId: string;
    sellerInstitutionId: string;
    assetCode: string;
    quantity: number;
    price: number;
  }): Promise<void> {
    const totalCost = params.quantity * params.price;

    // First check buyer has enough settlement asset
    const buyerPortfolio = await this.getPortfolio(params.buyerInstitutionId);
    const buyerCash = buyerPortfolio.holdings.find(
      (h) => h.assetCode === this.settlementAssetCode,
    );
    if (!buyerCash || buyerCash.balance < totalCost) {
      throw new InsufficientBalanceError(
        this.settlementAssetCode,
        totalCost,
        buyerCash?.balance ?? 0,
      );
    }

    // Check seller has enough of the asset
    const sellerPortfolio = await this.getPortfolio(
      params.sellerInstitutionId,
    );
    const sellerAsset = sellerPortfolio.holdings.find(
      (h) => h.assetCode === params.assetCode,
    );
    if (!sellerAsset || sellerAsset.balance < params.quantity) {
      throw new InsufficientBalanceError(
        params.assetCode,
        params.quantity,
        sellerAsset?.balance ?? 0,
      );
    }

    // Apply buyer adjustments with settlement change type
    await this.applyAdjustmentWithHistory({
      institutionId: params.buyerInstitutionId,
      assetCode: this.settlementAssetCode,
      delta: -totalCost,
      changeType: "settlement_buy",
    });
    await this.applyAdjustmentWithHistory({
      institutionId: params.buyerInstitutionId,
      assetCode: params.assetCode,
      delta: params.quantity,
      changeType: "settlement_buy",
    });

    // Apply seller adjustments with settlement change type
    await this.applyAdjustmentWithHistory({
      institutionId: params.sellerInstitutionId,
      assetCode: params.assetCode,
      delta: -params.quantity,
      changeType: "settlement_sell",
    });
    await this.applyAdjustmentWithHistory({
      institutionId: params.sellerInstitutionId,
      assetCode: this.settlementAssetCode,
      delta: totalCost,
      changeType: "settlement_sell",
    });
  }

  /**
   * Sync a portfolio from an external custody snapshot.
   * Any missing asset codes are treated as zero balance.
   */
  public async syncPortfolioSnapshot(params: {
    institutionId: string;
    holdings: ReadonlyArray<PortfolioSnapshotHolding>;
    sourceRef?: string;
    observedAt?: string;
  }): Promise<Portfolio> {
    const seenAssetCodes = new Set<string>();
    for (const holding of params.holdings) {
      if (seenAssetCodes.has(holding.assetCode)) {
        throw new PublicError("validation_failed", 400);
      }
      seenAssetCodes.add(holding.assetCode);
    }

    const before = await this.getPortfolio(params.institutionId);
    const beforeByAsset = new Map(
      before.holdings.map((holding) => [holding.assetCode, holding] as const),
    );
    const targetByAsset = new Map(
      params.holdings.map((holding) => [holding.assetCode, holding] as const),
    );

    const unionAssetCodes = new Set<string>([
      ...beforeByAsset.keys(),
      ...targetByAsset.keys(),
    ]);

    for (const assetCode of unionAssetCodes) {
      const targetBalance = targetByAsset.get(assetCode)?.balance ?? 0;
      const currentBalance = beforeByAsset.get(assetCode)?.balance ?? 0;
      const hadExistingRow = beforeByAsset.has(assetCode);

      if (targetBalance === currentBalance && hadExistingRow) {
        continue;
      }

      const { error } = await (this.client as unknown as RpcQuery<undefined>).rpc(
        "portfolio_sync_balance",
        {
          p_institution_id: params.institutionId,
          p_asset_code: assetCode,
          p_balance: targetBalance.toString(),
        },
      );

      if (error) {
        throw new PublicError("service_unavailable", 503, error);
      }

      const delta = targetBalance - currentBalance;
      if (Math.abs(delta) >= MINIMUM_HISTORY_DELTA) {
        await this.recordHistory({
          institutionId: params.institutionId,
          assetCode,
          delta,
          balanceAfter: targetBalance,
          changeType: "import",
          referenceType: "portfolio_snapshot",
          referenceId: params.sourceRef ?? params.observedAt ?? null,
        });
      }
    }

    return this.getPortfolio(params.institutionId);
  }

  /**
   * Record a history entry for a portfolio change.
   */
  private async recordHistory(params: {
    institutionId: string;
    assetCode: string;
    delta: number;
    balanceAfter: number;
    changeType: PortfolioHistoryChangeType;
    referenceType?: string | null;
    referenceId?: string | null;
  }): Promise<void> {
    const { error } = await (
      this.client as unknown as { from(table: string): { insert(values: Record<string, unknown>): Promise<{ error: Error | null }> } }
    ).from("portfolio_history").insert({
      institution_id: params.institutionId,
      asset_code: params.assetCode,
      delta: params.delta.toString(),
      balance_after: params.balanceAfter.toString(),
      change_type: params.changeType,
      reference_type: params.referenceType ?? null,
      reference_id: params.referenceId ?? null,
    });

    if (error) {
      // Non-critical — don't throw, just log
      console.error(
        `[PortfolioService] Failed to record history: ${error.message}`,
      );
    }
  }

  /**
   * Apply a single portfolio adjustment with history tracking.
   * Used for settlement operations where change_type differs from 'adjustment'.
   */
  private async applyAdjustmentWithHistory(params: {
    institutionId: string;
    assetCode: string;
    delta: number;
    changeType: PortfolioHistoryChangeType;
  }): Promise<void> {
    // Fetch current balance before update
    const before = await this.getPortfolio(params.institutionId);
    const currentBalance =
      before.holdings.find((h) => h.assetCode === params.assetCode)?.balance ?? 0;

    const { error } = await (this.client as unknown as RpcQuery<undefined>).rpc(
      "portfolio_update_balance",
      {
        p_institution_id: params.institutionId,
        p_asset_code: params.assetCode,
        p_delta: params.delta.toString(),
      },
    );

    if (error) {
      if (error.message?.includes("insufficient balance")) {
        throw new InsufficientBalanceError(
          params.assetCode,
          Math.abs(params.delta),
          0,
        );
      }
      throw new PublicError("service_unavailable", 503, error);
    }

    const balanceAfter = Math.max(0, currentBalance + params.delta);
    await this.recordHistory({
      institutionId: params.institutionId,
      assetCode: params.assetCode,
      delta: params.delta,
      balanceAfter,
      changeType: params.changeType,
    });
  }

  /**
   * Get portfolio history for an institution, ordered most recent first.
   */
  public async getPortfolioHistory(
    institutionId: string,
    limit = 50,
  ): Promise<PortfolioHistoryEntry[]> {
    const { data, error } = await this.client
      .from("portfolio_history")
      .select("*")
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return (data ?? []).map(portfolioHistoryFromRecord).slice(0, limit);
  }

  /**
   * Lock a portion of an institution's available balance for a
   * pending trading intent. The lock amount is added to
   * `portfolios.locked`; the institution's *available* balance
   * (balance - locked) is reduced by the same amount.
   *
   * Available balance is computed at the database level inside the
   * `portfolio_lock_balance` RPC, which holds a row-level lock via
   * `SELECT ... FOR UPDATE` to make this safe against concurrent
   * locks. If the institution's available balance is below the
   * requested amount, the RPC raises and this method throws
   * `InsufficientBalanceError` so callers can convert it to a
   * 403 `authorization_failed` response.
   */
  public async lockBalance(
    institutionId: string,
    assetCode: string,
    amount: number,
  ): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PublicError("validation_failed", 400);
    }

    const { error } = await (
      this.client as unknown as RpcQuery<undefined>
    ).rpc("portfolio_lock_balance", {
      p_institution_id: institutionId,
      p_asset_code: assetCode.toUpperCase(),
      p_amount: amount.toString(),
    });

    if (error) {
      if (error.message?.includes("insufficient available balance")) {
        // Best-effort parse the available amount from the SQL
        // error message. Format:
        //   "insufficient available balance for USDC: requested 1000, available 500"
        const match = /available (-?\d+(?:\.\d+)?)/.exec(error.message);
        const available = match ? Number.parseFloat(match[1]!) : 0;
        throw new InsufficientBalanceError(
          assetCode.toUpperCase(),
          amount,
          available,
        );
      }
      throw new PublicError("service_unavailable", 503, error);
    }
  }

  /**
   * Release a previously-locked balance reservation. Best-effort:
   * errors are logged but never thrown to the caller, because the
   * caller (the matching orchestrator) has already committed to the
   * in-memory state change (intent removed from queue) and cannot
   * roll it back.
   *
   * Safe under concurrent / duplicate calls: the SQL function
   * clamps `locked = GREATEST(locked - amount, 0)`, so calling
   * `releaseBalance` twice with the same amount is a no-op on the
   * second call rather than an error.
   */
  public async releaseBalance(
    institutionId: string,
    assetCode: string,
    amount: number,
  ): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    try {
      const { error } = await (
        this.client as unknown as RpcQuery<undefined>
      ).rpc("portfolio_release_balance", {
        p_institution_id: institutionId,
        p_asset_code: assetCode.toUpperCase(),
        p_amount: amount.toString(),
      });

      if (error) {
        console.error(
          `[PortfolioService] Failed to release ${amount} ${assetCode} for ${institutionId}: ${error.message}`,
        );
      }
    } catch (error) {
      console.error(
        `[PortfolioService] Release threw for ${amount} ${assetCode} on ${institutionId}:`,
        error,
      );
    }
  }
}
