import { describe, expect, it, vi } from "vitest";
import type { RedactedNegotiationSessionView } from "../../sdk/agent-client/index.js";
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
    assetCode: "WBTC",
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

function pls(input: {
  sessions: readonly RedactedNegotiationSessionView[];
  sessionId: string | undefined;
  now?: number;
  side?: "buy" | "sell";
  sessionCreatedAfter?: number;
}): RedactedNegotiationSessionView | null {
  const args: {
    sessions: readonly RedactedNegotiationSessionView[];
    sessionId: string | undefined;
    now: number;
    side?: "buy" | "sell";
    sessionCreatedAfter?: number;
  } = {
    sessions: input.sessions,
    sessionId: input.sessionId,
    now: input.now ?? Date.now(),
  };
  if (input.side !== undefined) args.side = input.side;
  if (input.sessionCreatedAfter !== undefined) args.sessionCreatedAfter = input.sessionCreatedAfter;
  return pickLiveSession(args);
}

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
    expect(pls({ sessions: [], sessionId: undefined })).toBeNull();
    expect(pls({ sessions: [], sessionId: "session-1" })).toBeNull();
  });

  it("follows the sessionId when one is already known", () => {
    const active = build({ id: "session-1", status: "active" });
    const expired = build({ id: "session-2", status: "expired" });
    expect(pls({ sessions: [active, expired], sessionId: "session-1" })).toBe(active);
    // Even if the tracked session is now terminal we still return it
    // so the caller can surface the terminal outcome instead of
    // accidentally picking up a stale actionable session.
    expect(pls({ sessions: [active, expired], sessionId: "session-2" })).toBe(expired);
  });

  it("returns null when no sessionId is known and only terminal sessions are visible (pairing wait)", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    const settled = build({ id: "old-settled", status: "settled" });
    expect(
      pls({
        sessions: [expired, walkedAway, settled],
        sessionId: undefined,
        now: Date.now(),
      }),
    ).toBeNull();
  });

  it("returns the first actionable session regardless of whose turn it is (turn check handled by loop body)", () => {
    const otherTurn = build({
      id: "other-turn",
      status: "active",
      currentTurn: "sell",
    });
    expect(
      pls({
        sessions: [otherTurn],
        sessionId: undefined,
        now: Date.now(),
        side: "buy",
      }),
    ).toBe(otherTurn);
  });

  it("returns null when only terminal sessions are visible (pairing wait)", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    expect(
      pls({
        sessions: [expired, walkedAway],
        sessionId: undefined,
        now: Date.now(),
      }),
    ).toBeNull();
  });

  it("returns the first actionable session (discovery picks the most recent)", () => {
    const activeA = build({ id: "a", status: "active" });
    const activeB = build({ id: "b", status: "active" });
    expect(
      pls({
        sessions: [activeA, activeB],
        sessionId: undefined,
      }),
    ).toBe(activeA);
  });

  it("regression: still ignores a zombie 'active' session whose deadline has already passed once we have a sessionId", () => {
    const zombie = build({
      id: "zombie",
      status: "active",
      deadline: pastDeadline,
    });
    const fresh = build({ id: "fresh", status: "active" });
    expect(pls({ sessions: [zombie, fresh], sessionId: "zombie" })).toBe(zombie);
    expect(pls({ sessions: [zombie, fresh], sessionId: "fresh" })).toBe(fresh);
  });

  it("regression: returns null when only zombie 'active' sessions are visible and we have no sessionId", () => {
    const zombie = build({
      id: "zombie",
      status: "active",
      deadline: pastDeadline,
    });
    expect(pls({ sessions: [zombie], sessionId: undefined, now: Date.now() })).toBeNull();
  });

  it("accepts an injected 'now' for deterministic tests", () => {
    const now = Date.parse("2026-06-18T00:00:00.000Z");
    const before = new Date(now - 1).toISOString();
    const after = new Date(now + 1).toISOString();
    const pastSession = build({ id: "past", status: "active", deadline: before });
    const futureSession = build({ id: "future", status: "active", deadline: after });
    // sessionId-bound: returns the requested session regardless of deadline.
    expect(pls({ sessions: [pastSession, futureSession], sessionId: "past", now })).toBe(pastSession);
    expect(pls({ sessions: [pastSession, futureSession], sessionId: "future", now })).toBe(futureSession);
    // No sessionId: respects deadline.
    expect(pls({ sessions: [pastSession, futureSession], sessionId: undefined, now, side: "buy" })).toBe(
      futureSession,
    );
  });

  it("regression: filters out stale sessions from prior runs via sessionCreatedAfter", () => {
    const now = Date.now();
    const stale = build({
      id: "stale",
      status: "active",
      createdAt: new Date(now - 120_000).toISOString(),
    });
    const fresh = build({
      id: "fresh",
      status: "active",
      createdAt: new Date(now - 5_000).toISOString(),
    });
    // sessionCreatedAfter after stale was created → stale filtered out
    expect(
      pls({
        sessions: [stale, fresh],
        sessionId: undefined,
        now,
        sessionCreatedAfter: now - 60_000,
      }),
    ).toBe(fresh);
    // sessionCreatedAfter before both → first session returned
    expect(
      pls({
        sessions: [stale, fresh],
        sessionId: undefined,
        now,
        sessionCreatedAfter: now - 300_000,
      }),
    ).toBe(stale);
    // No sessionCreatedAfter (legacy compat) → first session returned
    expect(pls({ sessions: [stale, fresh], sessionId: undefined, now })).toBe(stale);
  });

  it("regression: sessionId-bound lookup ignores sessionCreatedAfter", () => {
    const now = Date.now();
    const stale = build({
      id: "stale",
      status: "active",
      createdAt: new Date(now - 120_000).toISOString(),
    });
    // Even with a strict sessionCreatedAfter, a sessionId-bound
    // lookup returns the session because the agent already owns it.
    expect(
      pls({
        sessions: [stale],
        sessionId: "stale",
        now,
        sessionCreatedAfter: now - 60_000,
      }),
    ).toBe(stale);
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

// Suppress unused-import warnings for vi + RedactedNegotiationSessionView
// when the test file is loaded in isolation (the variables are used in
// the buildSession helper above; this is a defensive no-op).
void vi;
void ({} as RedactedNegotiationSessionView);
