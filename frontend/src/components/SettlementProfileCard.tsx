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
  BitcoinIcon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Dollar01Icon,
  EthereumIcon,
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
    <div className="card settlement-profile-card">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield01Icon size={18} style={{ color: "var(--color-accent)" }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-text-primary)' }}>
            Settlement Profile
          </h3>
        </div>
        
        {/* Profile Ref Badge */}
        <span style={{ 
          fontFamily: 'var(--font-mono)', 
          fontSize: '0.65rem', 
          background: 'rgba(255, 255, 255, 0.03)', 
          color: 'var(--color-text-secondary)',
          padding: '4px 8px', 
          borderRadius: '4px',
          border: '1px solid var(--color-border)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          {institution.settlementProfileRef}
        </span>
      </div>

      {/* Main content grid */}
      {isChainRail ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
          
          {/* Deposit Rail Address Widget */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Wallet01Icon size={12} /> Deposit Rail Address
            </span>
            
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px', 
              background: 'var(--color-input-bg)', 
              border: '1px solid var(--color-border)', 
              borderRadius: 'var(--radius-md)', 
              padding: 'var(--spacing-sm) var(--spacing-md)',
              minWidth: 0
            }}>
              <code style={{ 
                fontFamily: 'var(--font-mono)', 
                fontSize: '0.75rem', 
                color: 'var(--color-accent)', 
                wordBreak: 'break-all', 
                flex: 1 
              }}>
                {depositAddress ?? 'Address not initialized'}
              </code>
              {depositAddress && (
                <button
                  type="button"
                  onClick={handleCopyDeposit}
                  style={{ 
                    background: 'none', 
                    border: 'none', 
                    color: 'var(--color-text-muted)', 
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    borderRadius: 'var(--radius-sm)'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.color = 'var(--color-text-primary)'}
                  onMouseOut={(e) => e.currentTarget.style.color = 'var(--color-text-muted)'}
                  title="Copy deposit address"
                  aria-label="Copy deposit address"
                >
                  <Copy01Icon size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Deposit Wallet Balances Grid */}
          {depositStatus && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                  Deposit Wallet Balances
                </span>
                
                {/* Relayer Approval Status Badge */}
                <div className={`status-badge ${allApproved ? 'secure' : ''}`} style={{ fontSize: '0.6rem', padding: '2px 8px' }}>
                  {allApproved ? (
                    <>
                      <CheckmarkCircle01Icon size={10} /> Relayer Approved
                    </>
                  ) : (
                    <>
                      <AlertCircleIcon size={10} /> Approval Pending
                    </>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--spacing-sm)' }}>
                {/* sepETH Balance Card */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid rgba(255, 255, 255, 0.03)', borderRadius: '8px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--color-text-muted)' }}>
                    <EthereumIcon size={12} />
                    <span style={{ fontSize: '0.65rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>sepETH</span>
                  </div>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                    {depositStatus.balances.eth}
                  </code>
                </div>

                {/* WBTC Balance Card */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid rgba(255, 255, 255, 0.03)', borderRadius: '8px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--color-text-muted)' }}>
                    <BitcoinIcon size={12} />
                    <span style={{ fontSize: '0.65rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>WBTC</span>
                  </div>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                    {depositStatus.balances.wbtc}
                  </code>
                </div>

                {/* USDC Balance Card */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: 'var(--spacing-sm) var(--spacing-md)', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid rgba(255, 255, 255, 0.03)', borderRadius: '8px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--color-text-muted)' }}>
                    <Dollar01Icon size={12} />
                    <span style={{ fontSize: '0.65rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>USDC</span>
                  </div>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                    {depositStatus.balances.usdc}
                  </code>
                </div>
              </div>
            </div>
          )}

          {/* Active Token Contract Scope Addresses */}
          {tokenAddresses && Object.keys(tokenAddresses).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                Token Contract Scopes
              </span>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-sm)' }}>
                {Object.entries(tokenAddresses).map(([asset, address]) => (
                  <div key={asset} style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between', 
                    padding: '8px 12px', 
                    background: 'rgba(255, 255, 255, 0.01)', 
                    border: '1px solid rgba(255, 255, 255, 0.03)',
                    borderRadius: '8px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {asset === 'WBTC' ? <BitcoinIcon size={12} style={{ color: 'var(--color-accent)' }} /> : <Dollar01Icon size={12} style={{ color: 'var(--color-accent)' }} />}
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                        {asset}
                      </span>
                    </div>
                    <code style={{ 
                      fontFamily: 'var(--font-mono)', 
                      fontSize: '0.7rem', 
                      color: 'var(--color-text-muted)',
                      marginLeft: '8px'
                    }}>
                      {address.slice(0, 8)}...{address.slice(-6)}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Operator Action Buttons */}
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)', marginTop: 'var(--spacing-xs)' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', padding: '8px 12px', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={() => togglePanel("deposit")}
              aria-pressed={activePanel === "deposit"}
            >
              <Wallet01Icon size={12} /> Deposit
            </button>
            
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', padding: '8px 12px', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={handleApprove}
              disabled={approveBusy}
            >
              {approveBusy ? (
                <>
                  <Loading03Icon size={12} style={{ animation: "spin 1s linear infinite" }} /> Approving...
                </>
              ) : (
                <>
                  <Shield01Icon size={12} /> Approve Relayer
                </>
              )}
            </button>
            
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', padding: '8px 12px', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={() => togglePanel("withdraw")}
              aria-pressed={activePanel === "withdraw"}
            >
              <RocketIcon size={12} /> Withdraw
            </button>
          </div>

          {/* Action Error Banner */}
          {actionError && (
            <div className="status-badge error" style={{ padding: '6px 12px', fontSize: '0.72rem', width: '100%', boxSizing: 'border-box', justifyContent: 'flex-start', margin: 'var(--spacing-xs) 0' }}>
              <AlertCircleIcon size={14} /> {actionError}
            </div>
          )}

          {/* Relayer Approval Success Banner */}
          {approveResult && (
            <div style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', margin: 'var(--spacing-xs) 0' }}>
              <div style={{ color: 'var(--color-success)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem' }}>
                <CheckmarkCircle01Icon size={14} /> Relayer approval submitted successfully
              </div>
              <ApprovalTxLinks result={approveResult} />
            </div>
          )}

          {/* Inline Action Panels */}
          {activePanel === "deposit" && (
            <div className="settlement-profile-card__panel" style={{ padding: 'var(--spacing-md)', background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                Transfer assets from your connected browser wallet directly to the enclave deposit address on Sepolia.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-sm)' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Asset</label>
                  <select
                    className="form-select"
                    value={depositAsset}
                    onChange={(e) => setDepositAsset(e.target.value as DepositAsset)}
                    style={{ height: '34px', padding: '6px 12px', fontSize: '0.75rem' }}
                  >
                    {DEPOSIT_ASSETS.map((asset) => (
                      <option key={asset} value={asset}>
                        {assetLabel(asset)}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Amount</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="0.0"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    style={{ height: '34px', padding: '6px 12px', fontSize: '0.75rem' }}
                  />
                </div>
              </div>
              
              <button
                type="button"
                className="btn btn-primary"
                style={{ alignSelf: 'flex-end', padding: '6px 16px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}
                onClick={handleDeposit}
                disabled={depositBusy || !depositAmount.trim()}
              >
                {depositBusy ? (
                  <>
                    <Loading03Icon size={12} style={{ animation: "spin 1s linear infinite" }} /> Confirming...
                  </>
                ) : (
                  "Execute Deposit"
                )}
              </button>

              {depositResult && (
                <div style={{ padding: '8px 12px', background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', color: 'var(--color-success)', fontWeight: 600 }}>
                    <CheckmarkCircle01Icon size={14} /> Sent {depositResult.amount} {assetLabel(depositResult.asset)}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                    Tx:{" "}
                    <a
                      href={SEPOLIA_ETHERSCAN_TX_BASE + depositResult.txHash}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settlement-profile-card__rail-link"
                    >
                      {shortenTxHash(depositResult.txHash)} <Link01Icon size={10} />
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}

          {activePanel === "withdraw" && (
            <div className="settlement-profile-card__panel" style={{ padding: 'var(--spacing-md)', background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                Initiate withdrawal out of the deposit wallet. Backend enclave authorizes and signs on-chain wallet transfer.
              </p>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-sm)' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Asset</label>
                  <select
                    className="form-select"
                    value={withdrawAsset}
                    onChange={(e) => setWithdrawAsset(e.target.value as WithdrawalAsset)}
                    style={{ height: '34px', padding: '6px 12px', fontSize: '0.75rem' }}
                  >
                    {WITHDRAW_ASSETS.map((asset) => (
                      <option key={asset} value={asset}>
                        {assetLabel(asset)}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Amount</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    placeholder="0.0"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    style={{ height: '34px', padding: '6px 12px', fontSize: '0.75rem' }}
                  />
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Destination address</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="0x..."
                  value={withdrawTo}
                  onChange={(e) => setWithdrawTo(e.target.value)}
                  style={{ height: '34px', padding: '6px 12px', fontSize: '0.75rem' }}
                />
              </div>

              <button
                type="button"
                className="btn btn-primary"
                style={{ alignSelf: 'flex-end', padding: '6px 16px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', marginTop: '4px' }}
                onClick={handleWithdraw}
                disabled={withdrawBusy || !withdrawAmount.trim() || !withdrawTo.trim()}
              >
                {withdrawBusy ? (
                  <>
                    <Loading03Icon size={12} style={{ animation: "spin 1s linear infinite" }} /> Processing...
                  </>
                ) : (
                  "Withdraw"
                )}
              </button>

              {withdrawResult && (
                <div style={{ padding: '8px 12px', background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', color: 'var(--color-success)', fontWeight: 600 }}>
                    <CheckmarkCircle01Icon size={14} /> Sent {withdrawResult.amount} {assetLabel(withdrawResult.asset)}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: '4px', fontFamily: 'var(--font-mono)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div>Remaining: <code>{withdrawResult.remainingBalance}</code></div>
                    <div>
                      Tx:{" "}
                      <a
                        href={SEPOLIA_ETHERSCAN_TX_BASE + withdrawResult.txHash}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settlement-profile-card__rail-link"
                      >
                        {shortenTxHash(withdrawResult.txHash)} <Link01Icon size={10} />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      ) : (
        <div style={{ padding: 'var(--spacing-md) 0', color: 'var(--color-text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>
          No active on-chain settlement rails for this profile type.
        </div>
      )}

      {/* Bottom Section: Recent Rail Activity */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)', marginTop: 'var(--spacing-xs)' }}>
        <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
          <RocketIcon size={12} /> Recent Rail Trade Refs
        </span>
        
        {recentRailRefs.length === 0 ? (
          <div style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
            No rail trades yet.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {recentRailRefs.map((trade) => (
              <li key={trade.id} style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                padding: '6px 10px', 
                background: 'rgba(255, 255, 255, 0.01)', 
                borderRadius: '6px',
                fontSize: '0.72rem'
              }}>
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
                  {trade.railId ?? "wallet:default"}
                </code>
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
                  <code style={{ fontFamily: 'var(--font-mono)' }}>{shortenTxHash(trade.railTradeRef)}</code>
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

