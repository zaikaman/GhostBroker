import { describe, expect, it } from "vitest";
import {
  computeAuthorityPolicyHash,
  parseAuthorityClaim,
  verifyAuthorityClaim,
  type AuthorityClaim,
} from "../auth/authority-claims.js";

const baseClaim: AuthorityClaim = {
  agentDid: "did:t3n:agent:us1-authorized",
  institutionId: "00000000-0000-4000-8000-000000000101",
  allowedActions: ["agent.admit", "intent.submit"],
  instrumentScope: ["listed-equity"],
  directionScope: ["buy", "sell"],
  maxNotionalMinorUnits: "100000000",
  limitReference: "limit-policy:institutional:block",
  validFrom: "2026-06-12T00:00:00.000Z",
  expiresAt: "2026-06-13T00:00:00.000Z",
  settlementScope: ["delivery-versus-payment"],
};

describe("authority claims", () => {
  it("parses policy dimensions and computes a stable hash", () => {
    const parsed = parseAuthorityClaim(baseClaim);

    expect(parsed.instrumentScope).toEqual(["listed-equity"]);
    expect(parsed.directionScope).toEqual(["buy", "sell"]);
    expect(parsed.maxNotionalMinorUnits).toBe("100000000");
    expect(parsed.limitReference).toBe("limit-policy:institutional:block");
    expect(parsed.settlementScope).toEqual(["delivery-versus-payment"]);
    expect(computeAuthorityPolicyHash(parsed)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts an active scoped claim", () => {
    expect(
      verifyAuthorityClaim({
        claim: baseClaim,
        agentDid: baseClaim.agentDid,
        institutionId: baseClaim.institutionId,
        requestedAction: "agent.admit",
        now: new Date("2026-06-12T12:00:00.000Z"),
      }),
    ).toMatchObject({ valid: true });
  });

  it("rejects expired, revoked, and over-scoped claims", () => {
    expect(
      verifyAuthorityClaim({
        claim: baseClaim,
        agentDid: baseClaim.agentDid,
        institutionId: baseClaim.institutionId,
        requestedAction: "agent.admit",
        now: new Date("2026-06-14T00:00:00.000Z"),
      }).failure,
    ).toBe("expired");

    expect(
      verifyAuthorityClaim({
        claim: { ...baseClaim, revokedAt: "2026-06-12T05:00:00.000Z" },
        agentDid: baseClaim.agentDid,
        institutionId: baseClaim.institutionId,
        requestedAction: "agent.admit",
        now: new Date("2026-06-12T12:00:00.000Z"),
      }).failure,
    ).toBe("revoked");

    expect(
      verifyAuthorityClaim({
        claim: baseClaim,
        agentDid: baseClaim.agentDid,
        institutionId: baseClaim.institutionId,
        requestedAction: "settlement.execute",
        now: new Date("2026-06-12T12:00:00.000Z"),
      }).failure,
    ).toBe("action_not_allowed");
  });
});
