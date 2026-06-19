import React, { useCallback, useEffect, useState } from "react";
import { apiClient, type Institution, type RelayerApprovalResponse } from "../services/api-client";
import { usePortfolioTelemetry } from "../hooks/usePortfolioTelemetry";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Link01Icon,
  Loading03Icon,
  Refresh01Icon,
  Shield01Icon,
  Wallet01Icon,
} from "hugeicons-react";
import { Skeleton } from "./Skeleton";

interface DepositWalletOverviewCardProps {
  institutionId: string;
}

export function DepositWalletOverviewCard({
  institutionId,
}: DepositWalletOverviewCardProps): React.JSX.Element {
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [depositStatus, setDepositStatus] = useState<RelayerApprovalResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const { refreshKey, refresh } = usePortfolioTelemetry();

  const loadData = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);

      const institutionData = await apiClient.getInstitution(institutionId);
      if (signal.aborted) return;

      const isChainRail =
        institutionData.settlementProfileRef === "chain:sepolia:erc20";

      if (isChainRail) {
        const depositData = await apiClient.getDepositStatus(institutionId);
        if (signal.aborted) return;
        setDepositStatus(depositData);
      } else {
        setDepositStatus(null);
      }

      setInstitution(institutionData);
      setIsLoading(false);
    } catch (err: unknown) {
      if (signal.aborted) return;
      setError(
        err instanceof Error ? err.message : "Failed to load deposit wallet status",
      );
      setIsLoading(false);
    }
  }, [institutionId]);

  useEffect(() => {
    const abortController = new AbortController();
    // setState calls inside loadData happen after Promises resolve
    // (async callbacks), not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData(abortController.signal);
    return () => abortController.abort();
  }, [loadData, refreshKey]);

  const handleCopyDepositAddress = async (): Promise<void> => {
    if (!depositStatus?.depositAddress) return;
    try {
      await navigator.clipboard.writeText(depositStatus.depositAddress);
    } catch {
      // Clipboard is best-effort here.
    }
  };

  if (isLoading) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        {/* Header Skeleton */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--spacing-md)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '60%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Skeleton variant="circle" width={18} height={18} />
              <Skeleton variant="title" width="70%" style={{ margin: 0 }} />
            </div>
            <Skeleton variant="text" width="90%" height={10} style={{ marginBottom: 0 }} />
          </div>
          <Skeleton variant="rect" width={80} height={24} style={{ borderRadius: '4px' }} />
        </div>

        {/* Deposit Address Block Skeleton */}
        <div style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)', padding: 'var(--spacing-sm) 0 var(--spacing-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ width: '80%' }}>
            <Skeleton variant="text" width={100} height={10} style={{ marginBottom: '4px' }} />
            <Skeleton variant="rect" height={20} style={{ borderRadius: '4px' }} />
          </div>
          <Skeleton variant="circle" width={16} height={16} />
        </div>

        {/* Metrics Grid Skeleton */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--spacing-md)' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <Skeleton variant="text" width={50} height={10} style={{ marginBottom: 0 }} />
              <Skeleton variant="rect" height={24} style={{ borderRadius: '4px' }} />
            </div>
          ))}
        </div>

        {/* Footer Skeleton */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--spacing-md)', paddingTop: 'var(--spacing-md)', borderTop: '1px solid rgba(255, 255, 255, 0.05)', flexWrap: 'wrap', gap: 'var(--spacing-md)' }}>
          <Skeleton variant="rect" width={130} height={22} style={{ borderRadius: '4px' }} />
          <Skeleton variant="text" width={220} height={12} style={{ marginBottom: 0 }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="card"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-muted)",
          padding: "var(--spacing-lg)",
          gap: "var(--spacing-sm)",
        }}
      >
        <AlertCircleIcon size={24} style={{ color: "var(--color-error)" }} />
        <div style={{ fontSize: "0.8rem" }}>Deposit wallet unavailable</div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          style={{
            fontSize: "0.7rem",
            padding: "4px 12px",
            fontFamily: "var(--font-mono)",
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <Refresh01Icon size={12} /> Retry
        </button>
      </div>
    );
  }

  if (!institution) {
    return <></>;
  }

  const isChainRail = institution.settlementProfileRef === "chain:sepolia:erc20";
  const allApproved = Boolean(
    depositStatus?.approved.wbtc && depositStatus?.approved.usdc,
  );

  if (!isChainRail) {
    return (
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "var(--spacing-sm)",
          }}
        >
          <Wallet01Icon size={18} style={{ color: "var(--color-accent)" }} />
          <h2 className="card-title" style={{ margin: 0 }}>
            Settlement Wallet
          </h2>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "0.75rem",
            color: "var(--color-text-secondary)",
            lineHeight: 1.5,
            maxWidth: "62ch",
          }}
        >
          This institution is not currently configured for the Sepolia deposit wallet
          rail. Settlement wallet balances appear here once the chain rail is enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--spacing-md)",
          marginBottom: "var(--spacing-sm)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <h2
            className="card-title"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              margin: 0,
            }}
          >
            <Wallet01Icon size={18} style={{ color: "var(--color-accent)" }} />{" "}
            Settlement Deposit Wallet
          </h2>
          <div
            style={{
              fontSize: "0.72rem",
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            On-chain balances used for relayer approval, settlement, and withdrawals.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          disabled={isLoading}
          style={{
            fontSize: "0.7rem",
            padding: "4px 10px",
            fontFamily: "var(--font-mono)",
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
          }}
          title="Refresh deposit wallet"
        >
          <Refresh01Icon size={12} /> Refresh
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--spacing-md)",
          padding: "var(--spacing-sm) 0 var(--spacing-md)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: "0.66rem",
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
            }}
          >
            Deposit address
          </div>
          <code
            style={{
              display: "block",
              marginTop: "4px",
              color: "var(--color-text-primary)",
              fontSize: "0.78rem",
              wordBreak: "break-all",
            }}
          >
            {depositStatus?.depositAddress ??
              ((institution.metadata?.depositAddress as string | undefined) ?? "Unavailable")}
          </code>
        </div>
        {depositStatus?.depositAddress && (
          <button
            type="button"
            className="settlement-profile-card__icon-btn"
            onClick={handleCopyDepositAddress}
            title="Copy deposit address"
            aria-label="Copy deposit address"
          >
            <Copy01Icon size={12} />
          </button>
        )}
      </div>

      {depositStatus ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: "var(--spacing-md)",
              paddingTop: "var(--spacing-md)",
            }}
          >
            <WalletMetric label="sepETH" value={depositStatus.balances.eth} />
            <WalletMetric label="WBTC" value={depositStatus.balances.wbtc} />
            <WalletMetric label="USDC" value={depositStatus.balances.usdc} />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--spacing-md)",
              marginTop: "var(--spacing-md)",
              paddingTop: "var(--spacing-md)",
              borderTop: "1px solid rgba(255, 255, 255, 0.05)",
              flexWrap: "wrap",
            }}
          >
            <div
              className={allApproved ? "status-badge secure" : "status-badge"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
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
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--color-text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <Shield01Icon size={12} style={{ color: "var(--color-accent)" }} />
              Manage deposits, withdrawals, and approvals in Settings
            </div>
          </div>
        </>
      ) : (
        <div
          style={{
            marginTop: "var(--spacing-md)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "var(--color-text-muted)",
            fontSize: "0.75rem",
          }}
        >
          <Link01Icon size={14} style={{ color: "var(--color-accent)" }} />
          Deposit wallet metadata is available, but live on-chain balances could not be
          read.
        </div>
      )}
    </div>
  );
}

function WalletMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: "0.66rem",
          color: "var(--color-text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1rem",
          fontWeight: 700,
          color: "var(--color-text-primary)",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default DepositWalletOverviewCard;
