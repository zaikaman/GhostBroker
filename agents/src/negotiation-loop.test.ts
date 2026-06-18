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

  it("returns null when no sessionId is known and no actionable session matches our side", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    const settled = build({ id: "old-settled", status: "settled" });
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    // Active session at the OTHER side's turn — we cannot act on it
    // yet. The agent must keep polling for the orchestrator to
    // pair us into a session that is at our turn.
    const otherTurn = build({
      id: "other-turn",
      status: "active",
      currentTurn: "sell",
      deadline: futureDeadline,
    });
    expect(
      pickLiveSession([otherTurn, expired, walkedAway, settled], undefined, Date.now(), "buy"),
    ).toBeNull();
  });

  it("returns null when only terminal sessions are visible (pairing wait)", () => {
    const expired = build({ id: "old-expired", status: "expired" });
    const walkedAway = build({ id: "old-walked", status: "walked_away" });
    expect(pickLiveSession([expired, walkedAway], undefined, Date.now(), "buy")).toBeNull();
  });

  it("with side filter: returns the freshest active session where it is our turn", () => {
    const otherTurn = build({ id: "not-our-turn", status: "active", currentTurn: "sell" });
    const ourTurn = build({ id: "our-turn", status: "active", currentTurn: "buy" });
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    const freshOurTurn = build({
      id: "fresh-our-turn",
      status: "active",
      currentTurn: "buy",
      deadline: futureDeadline,
    });
    // The session list is ordered created_at desc; the freshest
    // session whose currentTurn matches our side is the one we
    // were just paired into.
    expect(
      pickLiveSession([freshOurTurn, ourTurn, otherTurn], undefined, Date.now(), "buy"),
    ).toBe(freshOurTurn);
  });

  it("with side filter: skips sessions whose currentTurn is the other side", () => {
    // Regression: the legacy pickLiveSession would adopt the
    // freshest actionable session regardless of whose turn it is.
    // The seller in a fresh pairing was adopting the buyer's
    // session and submitting moves on the buyer's turn, which
    // the orchestrator accepted (because the move itself was
    // structurally valid) but advanced the wrong turn — silently
    // corrupting session state. The `currentTurn === side` filter
    // fixes that.
    const ourTurn = build({ id: "our-turn", status: "active", currentTurn: "buy" });
    const otherTurn = build({ id: "other-turn", status: "active", currentTurn: "sell" });
    expect(
      pickLiveSession([otherTurn, ourTurn], undefined, Date.now(), "buy"),
    ).toBe(ourTurn);
  });

  it("regression: still ignores a zombie 'active' session whose deadline has already passed once we have a sessionId", () => {
    // A previous run may have left a session in `status = "active"`
    // in the database if the agent exhausted MAX_TICKS without ever
    // calling `submitMove` after the deadline (so the orchestrator
    // never explicitly flipped it to "expired"). When the agent
    // DOES have a sessionId, the existing session-lookup path
    // returns the requested session regardless of its deadline;
    // the orchestrator's own deadline check is what terminates it
    // on submit.
    const zombie = build({
      id: "zombie",
      status: "active",
      deadline: pastDeadline,
    });
    const fresh = build({ id: "fresh", status: "active" });
    expect(pickLiveSession([zombie, fresh], "zombie")).toBe(zombie);
    expect(pickLiveSession([zombie, fresh], "fresh")).toBe(fresh);
  });

  it("regression: returns null when only zombie 'active' sessions are visible and we have no sessionId", () => {
    const zombie = build({
      id: "zombie",
      status: "active",
      deadline: pastDeadline,
    });
    expect(pickLiveSession([zombie], undefined, Date.now(), "buy")).toBeNull();
  });

  it("accepts an injected 'now' for deterministic tests", () => {
    const now = Date.parse("2026-06-18T00:00:00.000Z");
    const before = new Date(now - 1).toISOString();
    const after = new Date(now + 1).toISOString();
    const pastSession = build({ id: "past", status: "active", currentTurn: "buy", deadline: before });
    const futureSession = build({ id: "future", status: "active", currentTurn: "buy", deadline: after });
    // sessionId-bound: returns the requested session regardless of deadline.
    expect(pickLiveSession([pastSession, futureSession], "past", now)).toBe(pastSession);
    expect(pickLiveSession([pastSession, futureSession], "future", now)).toBe(futureSession);
    // No sessionId + side filter: respects deadline.
    expect(pickLiveSession([pastSession, futureSession], undefined, now, "buy")).toBe(futureSession);
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
