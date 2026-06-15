import React, { useCallback, useEffect, useState } from "react";
import {
  apiClient,
  type CompletedTrade,
  type Institution,
  type RelayerApprovalResponse,
  type WithdrawalAsset,
  type WithdrawResponse,
} from "../services/api-client";
import {
  depositWithWallet,
  type DepositAsset,
  type DepositAssetConfig,
  type DepositWithWalletResult,
} from "../services/wallet-deposit";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Link01Icon,
  Loading03Icon,
  RocketIcon,
  Shield01Icon,
  Wallet01Icon,
} from "hugeicons-react";

/**
 * WS6: settlement profile card.
 *
 * Displays the institution's settlement profile, the
 * server-managed chain-rail deposit wallet, the per-asset
 * token addresses, and the most recent rail trade refs.
 * For chain-rail institutions it exposes three operator
 * actions:
 *
 *   - Deposit: the operator signs a transfer from their own
 *     browser wallet straight to the deposit address. The
 *     server never holds the operator funds; assets move on
 *     chain wallet-to-wallet.
 *   - Approve relayer: a server action. The backend holds
 *     the per-institution deposit wallet key and signs the
 *     ERC-20 approval so the settlement relayer can move
 *     assets during a trade. Only the server can do this
 *     because only it controls the deposit wallet key.
 *   - Withdraw: the backend signs and broadcasts a transfer
 *     out of the deposit wallet to an operator destination.
 */
interface SettlementProfileCardProps {
  institutionId: string;
}

const SEPOLIA_ETHERSCAN_TX_BASE = "https://sepolia.etherscan.io/tx/";
const WITHDRAW_ASSETS: readonly WithdrawalAsset[] = ["ETH", "WBTC", "USDC"];
const DEPOSIT_ASSETS: readonly DepositAsset[] = ["ETH", "WBTC", "USDC"];
const ASSET_DECIMALS: Record<DepositAsset, number> = {
  ETH: 18,
  WBTC: 8,
  USDC: 6,
};

function assetLabel(asset: DepositAsset | WithdrawalAsset): string {
  return asset === "ETH" ? "sepETH" : asset;
}

export function SettlementProfileCard({
  institutionId,
}: SettlementProfileCardProps): React.JSX.Element {
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [trades, setTrades] = useState<readonly CompletedTrade[]>([]);
  const [depositStatus, setDepositStatus] =
    useState<RelayerApprovalResponse | null>(null);
  // `loading` starts true; the useEffect below flips it to
  // false when the data is ready. We do not call
  // setLoading(true) inside the effect to avoid the
  // `react-hooks/set-state-in-effect` lint rule.
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [activePanel, setActivePanel] = useState<
    "deposit" | "withdraw" | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [depositBusy, setDepositBusy] = useState<boolean>(false);
  const [depositResult, setDepositResult] =
    useState<DepositWithWalletResult | null>(null);
  const [depositAsset, setDepositAsset] = useState<DepositAsset>("USDC");
  const [depositAmount, setDepositAmount] = useState<string>("");

  const [approveBusy, setApproveBusy] = useState<boolean>(false);
  const [approveResult, setApproveResult] =
    useState<RelayerApprovalResponse | null>(null);

  const [withdrawBusy, setWithdrawBusy] = useState<boolean>(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawResponse | null>(
    null,
  );
  const [withdrawAsset, setWithdrawAsset] = useState<WithdrawalAsset>("USDC");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [withdrawTo, setWithdrawTo] = useState<string>("");

  const refreshDepositStatus = useCallback(
    async (isChainRail: boolean): Promise<void> => {
      if (!isChainRail) {
        setDepositStatus(null);
        return;
      }
      try {
        const status = await apiClient.getDepositStatus(institutionId);
        setDepositStatus(status);
      } catch {
        // Status is best-effort; the deposit address is still
        // shown from the institution metadata even if the RPC
        // read fails.
        setDepositStatus(null);
      }
    },
    [institutionId],
  );


  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setError(null);
    });

    void (async (): Promise<void> => {
      try {
        const [inst, tradeList] = await Promise.all([
          apiClient.getInstitution(institutionId),
          apiClient.getCompletedTrades(),
        ]);
        if (cancelled) return;
        setInstitution(inst);
        setTrades(tradeList.items);
        setLoading(false);
        await refreshDepositStatus(
          inst.settlementProfileRef === "chain:sepolia:erc20",
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [institutionId, refreshDepositStatus]);

  if (loading) {
    return (
      <div className="settlement-profile-card settlement-profile-card--loading">
        <Loading03Icon size={14} /> Loading settlement profile...
      </div>
    );
  }

  if (error) {
    return (
      <div className="settlement-profile-card settlement-profile-card--error">
        Failed to load settlement profile: {error}
      </div>
    );
  }

  if (!institution) {
    return <></>;
  }

  const isChainRail =
    institution.settlementProfileRef === "chain:sepolia:erc20";
  const depositAddress = isChainRail
    ? ((institution.metadata?.["depositAddress"] as string | undefined) ??
      depositStatus?.depositAddress)
    : undefined;
  const tokenAddresses = isChainRail
    ? (institution.metadata?.["tokenAddresses"] as
        | Record<string, string>
        | undefined)
    : undefined;

  const recentRailRefs = trades
    .filter((t) => t.railTradeRef !== null && t.railTradeRef !== undefined)
    .slice(0, 5);

  const togglePanel = (panel: "deposit" | "withdraw"): void => {
    setActionError(null);
    setActivePanel((current) => (current === panel ? null : panel));
  };

  const depositAssetConfig = (asset: DepositAsset): DepositAssetConfig => {
    const tokenAddress = asset === "ETH" ? undefined : tokenAddresses?.[asset];
    return {
      symbol: assetLabel(asset),
      decimals: ASSET_DECIMALS[asset],
      ...(tokenAddress ? { tokenAddress } : {}),
    };
  };

  const handleCopyDeposit = async (): Promise<void> => {
    if (!depositAddress) return;
    try {
      await navigator.clipboard.writeText(depositAddress);
    } catch {
      // Clipboard is best-effort; ignore failures.
    }
  };

  const handleDeposit = async (): Promise<void> => {
    if (!depositAddress) {
      setActionError("Deposit address is not available yet.");
      return;
    }
    setDepositBusy(true);
    setActionError(null);
    setDepositResult(null);
    try {
      const result = await depositWithWallet({
        asset: depositAsset,
        amount: depositAmount.trim(),
        depositAddress,
        assetConfig: depositAssetConfig(depositAsset),
      });
      setDepositResult(result);
      setDepositAmount("");
      await refreshDepositStatus(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDepositBusy(false);
    }
  };

  const handleApprove = async (): Promise<void> => {
    setApproveBusy(true);
    setActionError(null);
    setApproveResult(null);
    try {
      const result = await apiClient.approveRelayer(institutionId);
      setApproveResult(result);
      setDepositStatus(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproveBusy(false);
    }
  };

  const handleWithdraw = async (): Promise<void> => {
    setWithdrawBusy(true);
    setActionError(null);
    setWithdrawResult(null);
    try {
      const result = await apiClient.withdrawFromDeposit(institutionId, {
        asset: withdrawAsset,
        amount: withdrawAmount.trim(),
        toAddress: withdrawTo.trim(),
      });
      setWithdrawResult(result);
      setWithdrawAmount("");
      await refreshDepositStatus(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWithdrawBusy(false);
    }
  };

  const approved = depositStatus?.approved;
  const allApproved = Boolean(approved?.wbtc && approved?.usdc);

  return (
    <div className="settlement-profile-card">
      <div className="settlement-profile-card__header">
        <Shield01Icon size={16} style={{ color: "var(--color-accent)" }} />
        <h3>Settlement Profile</h3>
      </div>
      <div className="settlement-profile-card__row">
        <span className="settlement-profile-card__label">Profile ref</span>
        <code className="settlement-profile-card__value">
          {institution.settlementProfileRef}
        </code>
      </div>
      {isChainRail && (
        <>
          <div className="settlement-profile-card__row">
            <span className="settlement-profile-card__label">
              <Wallet01Icon size={12} /> Deposit address
            </span>
            <span className="settlement-profile-card__value-group">
              <code className="settlement-profile-card__value">
                {depositAddress ?? <em>not set</em>}
              </code>
              {depositAddress && (
                <button
                  type="button"
                  className="settlement-profile-card__icon-btn"
                  onClick={handleCopyDeposit}
                  title="Copy deposit address"
                  aria-label="Copy deposit address"
                >
                  <Copy01Icon size={12} />
                </button>
              )}
            </span>
          </div>

          {depositStatus && (
            <div className="settlement-profile-card__row settlement-profile-card__row--block">
              <span className="settlement-profile-card__label">
                Deposit wallet balances
              </span>
              <ul className="settlement-profile-card__token-list">
                <li>
                  <code>sepETH</code> -&gt; <code>{depositStatus.balances.eth}</code>
                </li>
                <li>
                  <code>WBTC</code> -&gt; <code>{depositStatus.balances.wbtc}</code>
                </li>
                <li>
                  <code>USDC</code> -&gt; <code>{depositStatus.balances.usdc}</code>
                </li>
              </ul>
              <div
                className={
                  allApproved
                    ? "status-badge success settlement-profile-card__action-status"
                    : "status-badge settlement-profile-card__action-status"
                }
              >
                {allApproved ? (
                  <>
                    <CheckmarkCircle01Icon size={14} /> Relayer approved
                  </>
                ) : (
                  <>
                    <AlertCircleIcon size={14} /> Relayer approval pending
                  </>
                )}
              </div>
            </div>
          )}

          {tokenAddresses && Object.keys(tokenAddresses).length > 0 && (
            <div className="settlement-profile-card__row settlement-profile-card__row--block">
              <span className="settlement-profile-card__label">Token addresses</span>
              <ul className="settlement-profile-card__token-list">
                {Object.entries(tokenAddresses).map(([asset, address]) => (
                  <li key={asset}>
                    <code>{asset}</code> -&gt; <code>{address}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="settlement-profile-card__actions">
            <button
              type="button"
              className="btn btn-primary settlement-profile-card__action-btn"
              onClick={() => togglePanel("deposit")}
              aria-pressed={activePanel === "deposit"}
            >
              <Wallet01Icon size={14} /> Deposit
            </button>
            <button
              type="button"
              className="btn btn-secondary settlement-profile-card__action-btn"
              onClick={handleApprove}
              disabled={approveBusy}
            >
              {approveBusy ? (
                <>
                  <Loading03Icon
                    size={14}
                    style={{ animation: "spin 1s linear infinite" }}
                  />{" "}
                  Approving...
                </>
              ) : (
                <>
                  <Shield01Icon size={14} /> Approve relayer
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-secondary settlement-profile-card__action-btn"
              onClick={() => togglePanel("withdraw")}
              aria-pressed={activePanel === "withdraw"}
            >
              <RocketIcon size={14} /> Withdraw
            </button>
          </div>

          {actionError && (
            <div className="status-badge error settlement-profile-card__action-status">
              <AlertCircleIcon size={14} /> {actionError}
            </div>
          )}

          {approveResult && (
            <div className="settlement-profile-card__result">
              <div className="settlement-profile-card__result-head">
                <CheckmarkCircle01Icon
                  size={14}
                  style={{ color: "var(--color-success)" }}
                />
                <span>Relayer approval submitted</span>
              </div>
              <ApprovalTxLinks result={approveResult} />
            </div>
          )}

          {activePanel === "deposit" && (
            <div className="settlement-profile-card__panel">
              <p className="settlement-profile-card__panel-hint">
                Send assets from your own wallet to the deposit address. Your
                wallet signs the transfer on Sepolia; nothing is custodied by
                the browser.
              </p>
              <div className="settlement-profile-card__field-grid">
                <label className="settlement-profile-card__field">
                  <span>Asset</span>
                  <select
                    className="form-select"
                    value={depositAsset}
                    onChange={(e) =>
                      setDepositAsset(e.target.value as DepositAsset)
                    }
                  >
                    {DEPOSIT_ASSETS.map((asset) => (
                      <option key={asset} value={asset}>
                        {assetLabel(asset)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settlement-profile-card__field settlement-profile-card__field--wide">
                  <span>Amount</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="0.0"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                  />
                </label>
              </div>
              <div className="settlement-profile-card__panel-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleDeposit}
                  disabled={depositBusy || !depositAmount.trim()}
                >
                  {depositBusy ? (
                    <>
                      <Loading03Icon
                        size={14}
                        style={{ animation: "spin 1s linear infinite" }}
                      />{" "}
                      Confirm in wallet...
                    </>
                  ) : (
                    "Deposit"
                  )}
                </button>
              </div>
              {depositResult && (
                <div className="settlement-profile-card__result">
                  <div className="settlement-profile-card__result-head">
                    <CheckmarkCircle01Icon
                      size={14}
                      style={{ color: "var(--color-success)" }}
                    />
                    <span>
                      Sent {depositResult.amount}{" "}
                      {assetLabel(depositResult.asset)}
                    </span>
                  </div>
                  <ul className="settlement-profile-card__result-list">
                    <li>
                      Tx:{" "}
                      <a
                        href={SEPOLIA_ETHERSCAN_TX_BASE + depositResult.txHash}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settlement-profile-card__rail-link"
                      >
                        {shortenTxHash(depositResult.txHash)}{" "}
                        <Link01Icon size={10} />
                      </a>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {activePanel === "withdraw" && (
            <div className="settlement-profile-card__panel">
              <p className="settlement-profile-card__panel-hint">
                Sends assets out of the deposit wallet. The backend signs and
                broadcasts the transfer.
              </p>
              <div className="settlement-profile-card__field-grid">
                <label className="settlement-profile-card__field">
                  <span>Asset</span>
                  <select
                    className="form-select"
                    value={withdrawAsset}
                    onChange={(e) =>
                      setWithdrawAsset(e.target.value as WithdrawalAsset)
                    }
                  >
                    {WITHDRAW_ASSETS.map((asset) => (
                      <option key={asset} value={asset}>
                        {assetLabel(asset)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settlement-profile-card__field">
                  <span>Amount</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="0.0"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                  />
                </label>
                <label className="settlement-profile-card__field settlement-profile-card__field--wide">
                  <span>Destination address</span>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="0x..."
                    value={withdrawTo}
                    onChange={(e) => setWithdrawTo(e.target.value)}
                  />
                </label>
              </div>
              <div className="settlement-profile-card__panel-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleWithdraw}
                  disabled={
                    withdrawBusy ||
                    !withdrawAmount.trim() ||
                    !withdrawTo.trim()
                  }
                >
                  {withdrawBusy ? (
                    <>
                      <Loading03Icon
                        size={14}
                        style={{ animation: "spin 1s linear infinite" }}
                      />{" "}
                      Sending...
                    </>
                  ) : (
                    "Withdraw"
                  )}
                </button>
              </div>
              {withdrawResult && (
                <div className="settlement-profile-card__result">
                  <div className="settlement-profile-card__result-head">
                    <CheckmarkCircle01Icon
                      size={14}
                      style={{ color: "var(--color-success)" }}
                    />
                    <span>
                      Sent {withdrawResult.amount}{" "}
                      {assetLabel(withdrawResult.asset)}
                    </span>
                  </div>
                  <ul className="settlement-profile-card__result-list">
                    <li>
                      Remaining:{" "}
                      <code>{withdrawResult.remainingBalance}</code>
                    </li>
                    <li>
                      Tx:{" "}
                      <a
                        href={SEPOLIA_ETHERSCAN_TX_BASE + withdrawResult.txHash}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settlement-profile-card__rail-link"
                      >
                        {shortenTxHash(withdrawResult.txHash)}{" "}
                        <Link01Icon size={10} />
                      </a>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div className="settlement-profile-card__row settlement-profile-card__row--block">
        <span className="settlement-profile-card__label">
          <RocketIcon size={12} /> Recent rail trade refs
        </span>
        {recentRailRefs.length === 0 ? (
          <em className="settlement-profile-card__empty">No rail trades yet.</em>
        ) : (
          <ul className="settlement-profile-card__rail-list">
            {recentRailRefs.map((trade) => (
              <li key={trade.id}>
                <code className="settlement-profile-card__rail-id">
                  {trade.railId ?? "wallet:default"}
                </code>
                {" - "}
                {isChainRailTxHash(trade.railTradeRef) ? (
                  <a
                    href={SEPOLIA_ETHERSCAN_TX_BASE + trade.railTradeRef}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="settlement-profile-card__rail-link"
                  >
                    {shortenTxHash(trade.railTradeRef)}{" "}
                    <Link01Icon size={10} />
                  </a>
                ) : (
                  <code>{shortenTxHash(trade.railTradeRef)}</code>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ApprovalTxLinks({
  result,
}: {
  result: RelayerApprovalResponse;
}): React.JSX.Element {
  const entries = Object.entries(result.txHashes).filter(
    ([, hash]) => typeof hash === "string" && hash.length > 0,
  ) as [string, string][];
  if (entries.length === 0) {
    return (
      <p className="settlement-profile-card__panel-hint">
        Already approved. No new transactions were needed.
      </p>
    );
  }
  return (
    <ul className="settlement-profile-card__rail-list">
      {entries.map(([label, hash]) => (
        <li key={label}>
          <code className="settlement-profile-card__rail-id">{label}</code>
          {" - "}
          <a
            href={SEPOLIA_ETHERSCAN_TX_BASE + hash}
            target="_blank"
            rel="noopener noreferrer"
            className="settlement-profile-card__rail-link"
          >
            {shortenTxHash(hash)} <Link01Icon size={10} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Heuristic: a chain rail's `railTradeRef` is a 32-byte hex
 * string starting with `0x`. The noop rail's proof starts
 * with `noop:...`. We only render the Etherscan link when
 * the rail ref looks like a real tx hash.
 */
function isChainRailTxHash(railTradeRef: string | null | undefined): boolean {
  return (
    typeof railTradeRef === "string" &&
    railTradeRef.startsWith("0x") &&
    railTradeRef.length === 66
  );
}

function shortenTxHash(railTradeRef: string | null | undefined): string {
  if (!railTradeRef) return "(none)";
  if (railTradeRef.length <= 14) return railTradeRef;
  return `${railTradeRef.slice(0, 10)}...${railTradeRef.slice(-8)}`;
}

