import { describe, expect, it, vi } from "vitest";
import type { RedactedNegotiationSessionView } from "@ghostbroker/agent-client";
import {
  isActionableSessionStatus,
  pickLiveSession,
  withRetries,
} from "./negotiation-loop.js";

function buildSession(
  overrides: Partial<RedactedNegotiationSessionView> & {
    id: string;
    status: RedactedNegotiationSessionView["status"];
  },
): RedactedNegotiationSessionView {
  return {
    id: overrides.id,
    assetCode: "WBTC",
    status: overrides.status,
    currentTurn: "buy",
    roundNumber: 0,
    maxRounds: 12,
    deadline: new Date(Date.now() + 600_000).toISOString(),
    tradeRef: null,
    counterpartStandingProposal: { price: null, quantity: null },
    distanceSignal: null,
    trustLevel: "none",
    disclosureProgress: {
      requiredClaims: [],
      receivedVerifiedClaims: [],
      pendingRequiredClaims: [],
    },
    escalationStatus: "none",
    escalationPending: false,
    escalationReason: null,
    latestStrategySignal: null,
    disclosedClaims: [],
    rounds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("isActionableSessionStatus", () => {
  it("treats active / awaiting_approval / converged / settling as actionable", () => {
    for (const status of ["active", "awaiting_approval", "converged", "settling"] as const) {
      expect(isActionableSessionStatus(status)).toBe(true);
    }
  });

  it("treats settled / walked_away / expired as terminal", () => {
    for (const status of ["settled", "walked_away", "expired"] as const) {
      expect(isActionableSessionStatus(status)).toBe(false);
    }
  });
});

describe("pickLiveSession", () => {
  const futureDeadline = new Date(Date.now() + 600_000).toISOString();
  const pastDeadline = new Date(Date.now() - 60_000).toISOString();

  function build(
    overrides: Partial<RedactedNegotiationSessionView> & {
      id: string;
      status: RedactedNegotiationSessionView["status"];
      deadline?: string;
    },
  ): RedactedNegotiationSessionView {
    return buildSession({
      deadline: futureDeadline,
      ...overrides,
    });
  }

  it("returns null when the session list is empty", () => {
    expect(pickLiveSession([], undefined)).toBeNull();
    expect(pickLiveSession([], "session-1")).toBeNull();
  });

  it("follows the sessionId when one is already known", () => {
    const active = build({ id: "session-1", status: "active" });
    const expired = build({ id: "session-2", status: "expired" });
    expect(pickLiveSession([active, expired], "session-1")).toBe(active);
    // Even if the tracked session is now terminal we still return it
    // so the caller can surface the terminal outcome instead of
    // accidentally picking up a stale actionable session.
    expect(pickLiveSession([active, expired], "session-2")).toBe(expired);
  });

  it("skips terminal sessions and picks the most recent actionable one", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    const settled = build({ id: "old-settled", status: "settled" });
    const active = build({ id: "fresh-active", status: "active" });
    // Sessions are ordered created_at desc by the backend; the most
    // recent actionable session is the one the agent should join.
    expect(pickLiveSession([active, expired, walkedAway, settled], undefined)).toBe(active);
  });

  it("returns null when only terminal sessions are visible (pairing wait)", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    expect(pickLiveSession([expired, walkedAway], undefined)).toBeNull();
  });

  it("regression: does not blindly pick sessions[0] when a stale expired session sits at the top", () => {
    // This is the exact shape that caused the hosted agent to bail
    // out at tick 1: the SELL agent's submitTicket returned
    // sessionId=null (no pairing yet), then the loop's first
    // listNegotiationSessions returned an old expired session from
    // a previous run as `sessions[0]`. The agent picked it up,
    // surfaced `expired`, and exited before the BUY agent's
    // ticket could pair with it.
    const staleExpired = build({ id: "stale", status: "expired" });
    const freshActive = build({ id: "fresh", status: "active" });
    expect(pickLiveSession([staleExpired, freshActive], undefined)).toBe(freshActive);
  });

  it("regression: ignores a zombie 'active' session whose deadline has already passed", () => {
    // A previous run may have left a session in `status = "active"`
    // in the database if the agent exhausted MAX_TICKS without ever
    // calling `submitMove` after the deadline (so the orchestrator
    // never explicitly flipped it to "expired"). A status-only
    // filter would still pick this zombie up; the deadline is the
    // only reliable signal that it is dead.
    const zombie = build({
      id: "zombie",
      status: "active",
      deadline: pastDeadline,
    });
    const fresh = build({ id: "fresh", status: "active" });
    expect(pickLiveSession([zombie, fresh], undefined)).toBe(fresh);
    expect(pickLiveSession([zombie], undefined)).toBeNull();
  });

  it("regression: refuses to attach to a fresh-looking session that has already missed its deadline", () => {
    // New ticket was sealed, pairing just happened, but the
    // orchestrator's deadline has already lapsed (e.g. pairing took
    // so long that there is no time to negotiate). The agent should
    // treat this as no actionable session and keep polling rather
    // than adopt a session that will expire on the first move.
    const almostDone = build({
      id: "almost-done",
      status: "active",
      deadline: pastDeadline,
    });
    expect(pickLiveSession([almostDone], undefined)).toBeNull();
  });

  it("accepts an injected 'now' for deterministic tests", () => {
    const now = Date.parse("2026-06-18T00:00:00.000Z");
    const before = new Date(now - 1).toISOString();
    const after = new Date(now + 1).toISOString();
    const pastSession = build({ id: "past", status: "active", deadline: before });
    const futureSession = build({ id: "future", status: "active", deadline: after });
    expect(pickLiveSession([pastSession, futureSession], undefined, now)).toBe(futureSession);
  });
});

describe("withRetries", () => {
  it("returns the first successful value without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetries(fn, { maxAttempts: 3, retryDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures up to maxAttempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("ok");
    const onAttempt = vi.fn();
    const result = await withRetries(fn, {
      maxAttempts: 3,
      retryDelayMs: 1,
      onAttempt,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onAttempt).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });

  it("throws the last error when all attempts fail", async () => {
    const finalError = new Error("final");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(finalError);
    await expect(
      withRetries(fn, { maxAttempts: 3, retryDelayMs: 1 }),
    ).rejects.toBe(finalError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("regression: a single transient Groq failure does not force the agent to wait POLL_INTERVAL_MS", async () => {
    // The hosted-agent loop calls `withRetries` with retryDelayMs
    // in the low hundreds of milliseconds. Verify the total wall
    // time is bounded by the retry budget, not by the poll interval.
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("malformed JSON");
      }
      return "ok";
    };
    const start = Date.now();
    const result = await withRetries(fn, { maxAttempts: 3, retryDelayMs: 5 });
    const elapsed = Date.now() - start;
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(elapsed).toBeLessThan(100);
  });
});
