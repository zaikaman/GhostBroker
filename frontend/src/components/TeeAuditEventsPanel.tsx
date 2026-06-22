import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Loading03Icon,
  Refresh01Icon,
  Cancel01Icon,
  ArrowDown01Icon,
} from "hugeicons-react";
import { apiClient, type TeeAuditBatch, type TeeAuditPage } from "../services/api-client";
import { Skeleton } from "./Skeleton";

interface CommitBadgeProps {
  committed: boolean;
}

function CommitBadge({ committed }: CommitBadgeProps): React.JSX.Element {
  if (committed) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 8px",
          borderRadius: "9999px",
          fontSize: "0.6rem",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          background: "rgba(94, 210, 156, 0.10)",
          border: "1px solid rgba(94, 210, 156, 0.35)",
          color: "var(--color-accent)",
        }}
      >
        <CheckmarkCircle01Icon size={11} /> Committed
      </span>
    );
  }
  return (
    <span
      title="Transaction rolled back — event is the contract's claim, not a committed fact"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "9999px",
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        cursor: "help",
        background: "rgba(214, 158, 46, 0.10)",
        border: "1px solid rgba(214, 158, 46, 0.40)",
        color: "#d69e2e",
      }}
    >
      <Cancel01Icon size={11} /> Rolled back
    </span>
  );
}

function outcomeColor(outcome: string): string {
  const normalized = outcome.toLowerCase();
  if (normalized === "success" || normalized === "ok") {
    return "var(--color-accent)";
  }
  if (normalized === "denied" || normalized === "failure" || normalized === "failed") {
    return "#e5707a";
  }
  return "var(--color-text-secondary)";
}

function formatTimestamp(tsMs: number): string {
  const date = new Date(tsMs);
  if (Number.isNaN(date.getTime())) {
    return String(tsMs);
  }
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function truncateDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 12)}\u2026${did.slice(-8)}`;
}

function formatDetails(details: string | null | undefined): string {
  if (!details) return "";
  try {
    const parsed = JSON.parse(details);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return details;
  }
}

interface EventRowProps {
  event: TeeAuditBatch["events"][number];
}

function EventRow({ event }: EventRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(event.details && event.details.trim().length > 0);
  const detailsText = useMemo(
    () => (hasDetails ? formatDetails(event.details) : ""),
    [hasDetails, event.details],
  );

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(120px, 150px) minmax(110px, 1fr) minmax(90px, 110px) minmax(90px, 110px) minmax(80px, 90px) 28px",
          gap: "var(--spacing-sm)",
          padding: "6px 10px",
          alignItems: "center",
          fontSize: "0.7rem",
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
          borderTop: "1px solid var(--color-border)",
        }}
      >
        <span style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
          {formatTimestamp(event.ts_ms)}
        </span>
        <span title={event.actor} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {truncateDid(event.actor)}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {event.vc_id === null || event.vc_id === undefined ? (
            <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>self-call</span>
          ) : (
            <span title={event.vc_id}>{truncateDid(event.vc_id)}</span>
          )}
        </span>
        <span>{event.action}</span>
        <span style={{ color: outcomeColor(event.outcome), fontWeight: 600 }}>
          {event.outcome}
        </span>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse details" : "Expand details"}
            aria-expanded={expanded}
            style={{
              background: "none",
              border: "none",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform var(--transition-fast)",
              transform: expanded ? "rotate(180deg)" : "none",
            }}
          >
            <ArrowDown01Icon size={12} />
          </button>
        ) : (
          <span />
        )}
      </div>
      {expanded && hasDetails && (
        <pre
          style={{
            margin: 0,
            padding: "var(--spacing-sm) var(--spacing-md)",
            background: "rgba(255, 255, 255, 0.02)",
            borderTop: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.68rem",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowX: "auto",
          }}
        >
          {detailsText}
        </pre>
      )}
    </div>
  );
}

interface BatchCardProps {
  batch: TeeAuditBatch;
}

function BatchCard({ batch }: BatchCardProps): React.JSX.Element {
  const headerEvent = batch.events[0];
  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.01)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--spacing-sm)",
          padding: "8px 12px",
          background: "rgba(255, 255, 255, 0.02)",
          borderBottom: "1px solid var(--color-border)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
          <CommitBadge committed={batch.committed} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.02em",
            }}
          >
            key {truncateDid(batch.key)}
          </span>
          {headerEvent && (
            <span
              title={headerEvent.actor}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--color-text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "260px",
              }}
            >
              {truncateDid(headerEvent.actor)}
            </span>
          )}
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--color-text-muted)" }}>
          {batch.events.length} event{batch.events.length === 1 ? "" : "s"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {batch.events.map((event, index) => (
          <EventRow key={`${batch.key}-${index}`} event={event} />
        ))}
      </div>
    </div>
  );
}

export function TeeAuditEventsPanel(): React.JSX.Element {
  const [page, setPage] = useState<TeeAuditPage | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hideUncommitted, setHideUncommitted] = useState<boolean>(false);

  const load = useCallback(
    async (nextCursor?: string) => {
      if (nextCursor) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);
      try {
        const result = await apiClient.getAuditEvents(
          nextCursor ? { cursor: nextCursor, limit: 20 } : { limit: 20 },
        );
        setPage((prev) => {
          if (!prev || !nextCursor) {
            return result;
          }
          return {
            batches: [...prev.batches, ...result.batches],
            next_cursor: result.next_cursor ?? null,
          };
        });
        setCursor(result.next_cursor ?? undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load TEE audit events.");
        if (!nextCursor) {
          setPage(null);
        }
      } finally {
        if (nextCursor) {
          setIsLoadingMore(false);
        } else {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [load]);

  const visibleBatches = useMemo(() => {
    if (!page) return [];
    if (!hideUncommitted) return page.batches;
    return page.batches.filter((b) => b.committed);
  }, [page, hideUncommitted]);

  const hasMore = Boolean(cursor);

  const handleRefresh = useCallback(() => {
    setCursor(undefined);
    void load();
  }, [load]);

  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-md)",
        animation: "fadeIn 0.2s ease",
      }}
      data-testid="tee-audit-events-panel"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "var(--spacing-md)",
          borderBottom: "1px solid var(--color-border)",
          paddingBottom: "var(--spacing-sm)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 className="card-title" style={{ margin: 0, border: "none", padding: 0 }}>
            <CheckmarkCircle01Icon size={18} style={{ color: "var(--color-accent)" }} /> TEE Audit Trail
          </h2>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
            Live, append-only audit log of every contract execution inside the tenant TEE. Host-stamped identity, encrypted at rest.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleRefresh}
          disabled={isLoading}
          style={{
            padding: "6px 12px",
            fontSize: "0.7rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            opacity: isLoading ? 0.5 : 1,
          }}
          aria-label="Refresh audit trail"
        >
          <Refresh01Icon size={12} /> Refresh
        </button>
      </div>

      <div
        className="status-badge"
        style={{
          justifyContent: "flex-start",
          padding: "var(--spacing-sm) var(--spacing-md)",
          fontSize: "0.72rem",
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <AlertCircleIcon size={14} /> The audit trail is session-bound to the authenticated tenant DID. A rolled-back batch records the contract's claim, not a committed fact.
      </div>

      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "0.72rem",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={hideUncommitted}
          onChange={(e) => setHideUncommitted(e.target.checked)}
          style={{ accentColor: "var(--color-accent)" }}
        />
        Hide uncommitted (rolled-back) events
      </label>

      {error && (
        <div
          role="alert"
          style={{
            background: "rgba(255, 255, 255, 0.02)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--spacing-sm)",
            color: "var(--color-text-secondary)",
            fontSize: "0.75rem",
          }}
        >
          <AlertCircleIcon size={12} style={{ marginRight: "6px", verticalAlign: "middle" }} />
          {error}
        </div>
      )}

      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <Skeleton variant="rect" height={48} />
          <Skeleton variant="rect" height={48} />
          <Skeleton variant="rect" height={48} />
        </div>
      ) : visibleBatches.length === 0 && !error ? (
        <div
          style={{
            padding: "var(--spacing-lg)",
            textAlign: "center",
            color: "var(--color-text-muted)",
            fontSize: "0.8rem",
            fontFamily: "var(--font-mono)",
            border: "1px dashed var(--color-border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          No audit events recorded yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          {visibleBatches.map((batch, index) => (
            <BatchCard key={`${batch.key}-${index}`} batch={batch} />
          ))}
        </div>
      )}

      {hasMore && !isLoading && (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: "var(--spacing-xs)" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void load(cursor)}
            disabled={isLoadingMore}
            style={{
              padding: "8px 18px",
              fontSize: "0.72rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              opacity: isLoadingMore ? 0.5 : 1,
            }}
          >
            {isLoadingMore ? (
              <>
                <Loading03Icon size={12} className="spin" /> Loading&hellip;
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export default TeeAuditEventsPanel;
