import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  issueOperatorSessionToken,
  verifyOperatorSessionToken,
} from "../../auth/session-token.js";

const SECRET = "test-jwt-rls-alignment-secret-do-not-use-in-prod";
const INSTITUTION = "00000000-0000-4000-8000-000000000101";
const DID = "did:t3:0x0000000000000000000000000000000000000301";

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("malformed token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("operator session token RLS claim alignment", () => {
  it("writes institution_id (snake_case) so RLS policies resolve the operator's institution", () => {
    const token = issueOperatorSessionToken({
      secret: SECRET,
      did: DID,
      institutionId: INSTITUTION,
      walletAddress: "0x000000000000000000000000000000000000beef",
      depositAddress: "0x000000000000000000000000000000000000c0fe",
    });

    const payload = decodePayload(token);

    expect(payload.institution_id).toBe(INSTITUTION);
    expect(payload.institutionId).toBeUndefined();
    expect(payload.operator_id).toBe(`did:${DID}`);
    expect(payload.operatorId).toBeUndefined();
    expect(payload.wallet_address).toBe(
      "0x000000000000000000000000000000000000beef",
    );
    expect(payload.walletAddress).toBeUndefined();
    expect(payload.deposit_address).toBe(
      "0x000000000000000000000000000000000000c0fe",
    );
    expect(payload.depositAddress).toBeUndefined();
  });

  it("round-trips institutionId on the parsed claims without exposing the JWT snake_case keys", () => {
    const token = issueOperatorSessionToken({
      secret: SECRET,
      did: DID,
      institutionId: INSTITUTION,
    });

    const result = verifyOperatorSessionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.institutionId).toBe(INSTITUTION);
    expect(result.claims.operatorId).toBe(`did:${DID}`);
    expect(result.claims.did).toBe(DID);
    expect(
      (result.claims as unknown as Record<string, unknown>).institution_id,
    ).toBeUndefined();
  });

  it("still verifies tokens issued with the legacy camelCase claim keys (defensive decode)", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const legacyPayload = {
      sub: DID,
      did: DID,
      institutionId: INSTITUTION,
      operatorId: `did:${DID}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const body = `${header}.${Buffer.from(JSON.stringify(legacyPayload)).toString("base64url")}`;
    const sig = createHmac("sha256", SECRET)
      .update(body)
      .digest("base64url");
    const legacyToken = `${body}.${sig}`;

    const result = verifyOperatorSessionToken(legacyToken, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.institutionId).toBe(INSTITUTION);
    expect(result.claims.operatorId).toBe(`did:${DID}`);
  });
});
