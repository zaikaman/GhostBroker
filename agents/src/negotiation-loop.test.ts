import { describe, expect, it } from "vitest";
import type { RedactedNegotiationSessionView } from "@ghostbroker/agent-client";
import {
  isActionableSessionStatus,
  pickLiveSession,
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
  it("returns null when the session list is empty", () => {
    expect(pickLiveSession([], undefined)).toBeNull();
    expect(pickLiveSession([], "session-1")).toBeNull();
  });

  it("follows the sessionId when one is already known", () => {
    const active = buildSession({ id: "session-1", status: "active" });
    const expired = buildSession({ id: "session-2", status: "expired" });
    expect(pickLiveSession([active, expired], "session-1")).toBe(active);
    // Even if the tracked session is now terminal we still return it
    // so the caller can surface the terminal outcome instead of
    // accidentally picking up a stale actionable session.
    expect(pickLiveSession([active, expired], "session-2")).toBe(expired);
  });

  it("skips terminal sessions and picks the most recent actionable one", () => {
    const expired = buildSession({ id: "old-expired", status: "expired" });
    const walkedAway = buildSession({ id: "old-walked", status: "walked_away" });
    const settled = buildSession({ id: "old-settled", status: "settled" });
    const active = buildSession({ id: "fresh-active", status: "active" });
    // Sessions are ordered created_at desc by the backend; the most
    // recent actionable session is the one the agent should join.
    expect(pickLiveSession([active, expired, walkedAway, settled], undefined)).toBe(active);
  });

  it("returns null when only terminal sessions are visible (pairing wait)", () => {
    const expired = buildSession({ id: "old-expired", status: "expired" });
    const walkedAway = buildSession({ id: "old-walked", status: "walked_away" });
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
    const staleExpired = buildSession({ id: "stale", status: "expired" });
    const freshActive = buildSession({ id: "fresh", status: "active" });
    expect(pickLiveSession([staleExpired, freshActive], undefined)).toBe(freshActive);
  });
});
