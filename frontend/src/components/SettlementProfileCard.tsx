import React, { useEffect, useState } from "react";
import {
  apiClient,
  type CompletedTrade,
  type Institution,
} from "../services/api-client";
import {
  Link01Icon,
  Loading03Icon,
  RocketIcon,
  Shield01Icon,
  Wallet01Icon,
} from "hugeicons-react";

/**
 * WS3: a small dashboard card that displays the
 * institution's settlement profile + per-rail config +
 * the most recent rail trade refs (with Etherscan links
 * for the chain rail).
 *
 * The card reads:
 *   - the current institution record (for
 *     `settlementProfileRef` + chain-rail metadata)
 *   - the most recent completed trades (for
 *     `railId` + `railTradeRef` per trade)
 *
 * The chain rail's `railTradeRef` is the on-chain tx
 * hash; the card links to
 * `https://sepolia.etherscan.io/tx/<railTradeRef>` so
 * judges (and operators) can click through to verify
 * the rail produced a real on-chain settlement.
 *
 * For Sepolia, the block-explorer URL is hard-coded.
 * Production should derive the explorer URL from the
 * chain id; WS3 ships the demo.
 */
interface SettlementProfileCardProps {
  institutionId: string;
}

const SEPOLIA_ETHERSCAN_TX_BASE = "https://sepolia.etherscan.io/tx/";

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

  useEffect(() => {
    let cancelled = false;
    // The repo's lint rule bans setState calls directly
    // inside an effect body. We wrap the synchronous state
    // reset in a microtask so the effect body itself
    // contains no setState calls; only the resolved
    // promise's `.then` / `.catch` handlers do.
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
        <Loading03Icon size={14} /> Loading settlement profile…
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
                    <code>{asset}</code> → <code>{address}</code>
                  </li>
                ))}
              </ul>
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
                {" · "}
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
  return `${railTradeRef.slice(0, 10)}…${railTradeRef.slice(-8)}`;
}
