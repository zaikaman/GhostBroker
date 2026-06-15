import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiClientError, type DemoStatus } from "../services/api-client";
import { Rocket01Icon, Cancel01Icon, Loading03Icon, CheckmarkCircle01Icon, AlertCircleIcon, CodeIcon, EyeIcon } from "hugeicons-react";

/**
 * Phase 2.5: Demo Mode one-click spin-up.
 *
 * Rendered on the Observatory tab. Two states:
 *
 *   - **Idle**: a single "Spin up demo agents" button.
 *     The button click POSTs to `/api/demo/start`, the
 *     backend spawns the buyer + seller child processes,
 *     and the panel flips to the running state.
 *
 *   - **Running**: PID display, "Stop demo" button, and
 *     a collapsible "view logs" affordance that shows
 *     the most recent 4 KB of stdout/stderr from each
 *     child. The panel polls `getDemoStatus` every 2s
 *     while running so a backend-initiated stop (via
 *     SIGTERM, or the "Stop demo" button) is reflected
 *     without the user needing to refresh.
 *
 * The institution ID is the only prop — the API client
 * is already wired with the operator's session bearer
 * token via the `requestWithOperatorFallback` path.
 */
export interface DemoControlPanelProps {
  institutionId: string;
}

const POLL_INTERVAL_MS = 2_000;

export function DemoControlPanel({ institutionId }: DemoControlPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<DemoStatus>({ running: false });
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  // Initial load + polling while running. The poll stops
  // when the demo is no longer running (the component
  // stays mounted but the user is back in the idle
  // state).
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await apiClient.getDemoStatus();
        if (!cancelled) {
          setStatus(next);
          if (!next.running) {
            setError(null);
          }
        }
      } catch (err) {
        // Surface 503 as "service unavailable — demo
        // mode disabled on this backend" rather than
        // spamming the user with errors on every poll.
        if (err instanceof ApiClientError && err.status === 503) {
          if (!cancelled) {
            setStatus({ running: false });
          }
          return;
        }
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to read demo status.",
          );
        }
      }
    };
    void tick();
    if (!status.running) {
      return;
    }
    const id = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(id);
    };
    // We intentionally re-arm the interval whenever the
    // running flag flips so a transition into / out of
    // the running state restarts the poll cadence
    // cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.running]);

  const handleStart = useCallback(async (): Promise<void> => {
    setBusy("start");
    setError(null);
    try {
      const next = await apiClient.startDemo(institutionId);
      setStatus(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start demo.",
      );
    } finally {
      setBusy(null);
    }
  }, [institutionId]);

  const handleStop = useCallback(async (): Promise<void> => {
    setBusy("stop");
    setError(null);
    try {
      const next = await apiClient.stopDemo();
      setStatus(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to stop demo.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  if (!status.running) {
    return (
      <div className="card" style={cardStyle}>
        <div style={headerStyle}>
          <Rocket01Icon size={18} style={{ color: "var(--color-accent)" }} />
          <span style={headerLabelStyle}>Demo Mode</span>
        </div>
        <p style={descriptionStyle}>
          Spin up two LLM-driven agents (a buyer and a
          seller) that trade against this institution in
          real time. Watch the order book move and
          settlements finalize on the live activity
          stream.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void handleStart();
            }}
            disabled={busy === "start"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "var(--spacing-sm) var(--spacing-lg)",
            }}
          >
            {busy === "start" ? (
              <Loading03Icon size={14} />
            ) : (
              <Rocket01Icon size={14} />
            )}
            {busy === "start" ? "Spinning up…" : "Spin up demo agents"}
          </button>
          {error && (
            <span style={errorStyle}>
              <AlertCircleIcon size={12} />
              {error}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={cardStyle}>
      <div style={headerStyle}>
        <CheckmarkCircle01Icon
          size={18}
          style={{ color: "var(--color-success)" }}
        />
        <span style={headerLabelStyle}>Demo Mode — Running</span>
      </div>
      <div style={runningGridStyle}>
        <div style={runningRowStyle}>
          <span style={runningLabelStyle}>Buyer</span>
          <code style={codeStyle}>pid {status.buyerPid ?? "?"}</code>
        </div>
        <div style={runningRowStyle}>
          <span style={runningLabelStyle}>Seller</span>
          <code style={codeStyle}>pid {status.sellerPid ?? "?"}</code>
        </div>
        <div style={runningRowStyle}>
          <span style={runningLabelStyle}>Started</span>
          <code style={codeStyle}>
            {status.startedAt
              ? new Date(status.startedAt).toLocaleTimeString()
              : "—"}
          </code>
        </div>
        <div style={runningRowStyle}>
          <span style={runningLabelStyle}>Institution</span>
          <code style={codeStyle}>
            {status.institutionId?.slice(0, 8) ?? "—"}…
          </code>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          marginTop: "var(--spacing-md)",
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void handleStop();
          }}
          disabled={busy === "stop"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "var(--spacing-sm) var(--spacing-md)",
          }}
        >
          {busy === "stop" ? (
            <Loading03Icon size={14} />
          ) : (
            <Cancel01Icon size={14} />
          )}
          {busy === "stop" ? "Stopping…" : "Stop demo"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setShowLogs((v) => !v);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "var(--spacing-sm) var(--spacing-md)",
          }}
        >
          <EyeIcon size={14} />
          {showLogs ? "Hide logs" : "View logs"}
        </button>
        {error && (
          <span style={errorStyle}>
            <AlertCircleIcon size={12} />
            {error}
          </span>
        )}
      </div>
      {showLogs && (
        <div style={logsBlockStyle}>
          <div style={logRowStyle}>
            <div style={logLabelStyle}>
              <CodeIcon size={12} /> buyer
            </div>
            <pre style={logPreStyle}>
              {status.buyerLogTail?.trim() || "(no output yet)"}
            </pre>
          </div>
          <div style={logRowStyle}>
            <div style={logLabelStyle}>
              <CodeIcon size={12} /> seller
            </div>
            <pre style={logPreStyle}>
              {status.sellerLogTail?.trim() || "(no output yet)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "var(--spacing-md)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-sm)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-xs)",
};

const headerLabelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--color-text-secondary)",
};

const descriptionStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--color-text-secondary)",
  lineHeight: 1.4,
  margin: 0,
};

const runningGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "var(--spacing-xs) var(--spacing-md)",
  marginTop: "var(--spacing-xs)",
};

const runningRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-xs)",
};

const runningLabelStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--color-text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  minWidth: 80,
};

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.8rem",
  color: "var(--color-text-primary)",
};

const errorStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "0.75rem",
  color: "var(--color-error)",
};

const logsBlockStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "var(--spacing-sm)",
  marginTop: "var(--spacing-sm)",
};

const logRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const logLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-text-secondary)",
};

const logPreStyle: React.CSSProperties = {
  margin: 0,
  padding: "var(--spacing-xs)",
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.7rem",
  lineHeight: 1.4,
  maxHeight: 180,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--color-text-primary)",
};
