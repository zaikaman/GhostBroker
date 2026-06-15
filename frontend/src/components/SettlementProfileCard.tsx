import React, { useCallback, useEffect, useState } from "react";
import {
  apiClient,
  type CompletedTrade,
  type FundRelayerResponse,
  type Institution,
  type WithdrawalAsset,
  type WithdrawResponse,
} from "../services/api-client";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
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
 * token addresses, and the most recent rail trade refs
 * (with Etherscan links). For chain-rail institutions it
 * also exposes two operator actions:
 *
 *   - Fund + approve: tops up the deposit wallet with
 *     sepETH / WBTC / USDC and approves the relayer.
 *   - Withdraw: sends assets out of the deposit wallet to
 *     an operator-supplied destination address.
 *
 * Both actions are server-driven: the backend holds the
 * deposit wallet key (derived per-institution) and signs
 * the transactions. The UI only collects amounts and a
 * destination address.
 */
interface SettlementProfileCardProps {
  institutionId: string;
}

const SEPOLIA_ETHERSCAN_TX_BASE = "https://sepolia.etherscan.io/tx/";
const WITHDRAW_ASSETS: readonly WithdrawalAsset[] = ["ETH", "WBTC", "USDC"];

export function SettlementProfileCard({
  institutionId,
}: SettlementProfileCardProps): React.JSX.Element {
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [trades, setTrades] = useState<readonly CompletedTrade[]>([]);
  // `loading` starts true; the useEffect below flips it to
  // false when the data is ready. We do not call
  // setLoading(true) inside the effect to avoid the
  // `react-hooks/set-state-in-effect` lint rule.
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fund + withdraw panel state.
  const [activePanel, setActivePanel] = useState<"fund" | "withdraw" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [fundBusy, setFundBusy] = useState<boolean>(false);
  const [fundResult, setFundResult] = useState<FundRelayerResponse | null>(null);
  const [fundEth, setFundEth] = useState<string>("");
  const [fundWbtc, setFundWbtc] = useState<string>("");
  const [fundUsdc, setFundUsdc] = useState<string>("");

  const [withdrawBusy, setWithdrawBusy] = useState<boolean>(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawResponse | null>(
    null,
  );
  const [withdrawAsset, setWithdrawAsset] = useState<WithdrawalAsset>("USDC");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [withdrawTo, setWithdrawTo] = useState<string>("");

  const reload = useCallback(async (): Promise<void> => {
    const [inst, tradeList] = await Promise.all([
      apiClient.getInstitution(institutionId),
      apiClient.getCompletedTrades(),
    ]);
    setInstitution(inst);
    setTrades(tradeList.items);
  }, [institutionId]);

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
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [institutionId]);

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
    ? (institution.metadata?.["depositAddress"] as string | undefined)
    : undefined;
  const tokenAddresses = isChainRail
    ? (institution.metadata?.["tokenAddresses"] as
        | Record<string, string>
        | undefined)
    : undefined;

  // Surface only the most recent 5 rail refs.
  const recentRailRefs = trades
    .filter((t) => t.railTradeRef !== null && t.railTradeRef !== undefined)
    .slice(0, 5);

  const togglePanel = (panel: "fund" | "withdraw"): void => {
    setActionError(null);
    setActivePanel((current) => (current === panel ? null : panel));
  };

  const handleFund = async (): Promise<void> => {
    setFundBusy(true);
    setActionError(null);
    setFundResult(null);
    try {
      const result = await apiClient.fundRelayer(institutionId, {
        ...(fundEth.trim() ? { ethAmount: fundEth.trim() } : {}),
        ...(fundWbtc.trim() ? { wbtcAmount: fundWbtc.trim() } : {}),
        ...(fundUsdc.trim() ? { usdcAmount: fundUsdc.trim() } : {}),
      });
      setFundResult(result);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setFundBusy(false);
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
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWithdrawBusy(false);
    }
  };

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
            <code className="settlement-profile-card__value">
              {depositAddress ?? <em>not set</em>}
            </code>
          </div>
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
              onClick={() => togglePanel("fund")}
              aria-pressed={activePanel === "fund"}
            >
              <Wallet01Icon size={14} /> Fund &amp; approve relayer
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

          {activePanel === "fund" && (
            <div className="settlement-profile-card__panel">
              <p className="settlement-profile-card__panel-hint">
                Tops up the deposit wallet to the target balance and approves the
                relayer. Leave a field blank to use the configured default.
              </p>
              <div className="settlement-profile-card__field-grid">
                <label className="settlement-profile-card__field">
                  <span>sepETH</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="default"
                    value={fundEth}
                    onChange={(e) => setFundEth(e.target.value)}
                  />
                </label>
                <label className="settlement-profile-card__field">
                  <span>WBTC</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="default"
                    value={fundWbtc}
                    onChange={(e) => setFundWbtc(e.target.value)}
                  />
                </label>
                <label className="settlement-profile-card__field">
                  <span>USDC</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="default"
                    value={fundUsdc}
                    onChange={(e) => setFundUsdc(e.target.value)}
                  />
                </label>
              </div>
              <div className="settlement-profile-card__panel-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleFund}
                  disabled={fundBusy}
                >
                  {fundBusy ? (
                    <>
                      <Loading03Icon
                        size={14}
                        style={{ animation: "spin 1s linear infinite" }}
                      />{" "}
                      Funding...
                    </>
                  ) : (
                    "Fund + approve"
                  )}
                </button>
              </div>
              {fundResult && (
                <div className="settlement-profile-card__result">
                  <div className="settlement-profile-card__result-head">
                    <CheckmarkCircle01Icon
                      size={14}
                      style={{ color: "var(--color-success)" }}
                    />
                    <span>Deposit wallet funded</span>
                  </div>
                  <ul className="settlement-profile-card__result-list">
                    <li>
                      sepETH balance: <code>{fundResult.balances.eth}</code>
                    </li>
                    <li>
                      WBTC balance: <code>{fundResult.balances.wbtc}</code>
                    </li>
                    <li>
                      USDC balance: <code>{fundResult.balances.usdc}</code>
                    </li>
                  </ul>
                  <FundTxLinks result={fundResult} />
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
                        {asset === "ETH" ? "sepETH" : asset}
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
                      {withdrawResult.asset === "ETH"
                        ? "sepETH"
                        : withdrawResult.asset}
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

function FundTxLinks({
  result,
}: {
  result: FundRelayerResponse;
}): React.JSX.Element | null {
  const entries = Object.entries(result.txHashes).filter(
    ([, hash]) => typeof hash === "string" && hash.length > 0,
  ) as Array<[string, string]>;
  if (entries.length === 0) {
    return (
      <p className="settlement-profile-card__panel-hint">
        Already funded and approved. No new transactions were needed.
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
