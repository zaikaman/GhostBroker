import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Structured auth-failure reason so the middleware can log
 * exactly why verification failed instead of a silent 401.
 */
export type TokenVerificationFailure =
  | { kind: "malformed"; detail: string }
  | { kind: "signature_mismatch"; detail: string }
  | { kind: "expired"; detail: string }
  | { kind: "parse_error"; detail: string };

export interface OperatorSessionClaims {
  sub: string;
  did: string;
  institutionId: string;
  operatorId: string;
  walletAddress?: string;
  /**
   * The per-institution deposit wallet used by the chain settlement
   * rail (`settle()` pays out of this address). For chain-rail
   * institutions this is the balance source of truth, distinct
   * from `walletAddress` (the login wallet used for identity).
   * Only present for chain-rail institutions that have a derived
   * deposit address stamped in their metadata.
   */
  depositAddress?: string;
  iat: number;
  exp: number;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  did: z.string().min(1),
  institutionId: z.string().uuid(),
  operatorId: z.string().min(1),
  walletAddress: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  depositAddress: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

type ParsedClaims = z.infer<typeof claimsSchema>;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createOpaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function issueOperatorSessionToken(params: {
  secret: string;
  did: string;
  institutionId: string;
  walletAddress?: string;
  depositAddress?: string;
  ttlSeconds?: number;
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: OperatorSessionClaims = {
    sub: params.did,
    did: params.did,
    institutionId: params.institutionId,
    operatorId: `did:${params.did}`,
    iat: issuedAt,
    exp: issuedAt + (params.ttlSeconds ?? 60 * 60 * 8),
  };

  if (params.walletAddress) {
    claims.walletAddress = params.walletAddress;
  }
  if (params.depositAddress) {
    claims.depositAddress = params.depositAddress;
  }

  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode(claims);
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, params.secret)}`;
}

function toOperatorSessionClaims(parsed: ParsedClaims): OperatorSessionClaims {
  const claims: OperatorSessionClaims = {
    sub: parsed.sub,
    did: parsed.did,
    institutionId: parsed.institutionId,
    operatorId: parsed.operatorId,
    iat: parsed.iat,
    exp: parsed.exp,
  };

  if (parsed.walletAddress) {
    claims.walletAddress = parsed.walletAddress;
  }
  if (parsed.depositAddress) {
    claims.depositAddress = parsed.depositAddress;
  }

  return claims;
}

export function verifyOperatorSessionToken(
  token: string,
  secret: string,
):
  | { ok: true; claims: OperatorSessionClaims }
  | { ok: false; failure: TokenVerificationFailure }
{
  const parts = token.split(".");

  if (parts.length !== 3) {
    return {
      ok: false,
      failure: {
        kind: "malformed",
        detail: `expected 3 dot-separated segments, got ${parts.length}`,
      },
    };
  }

  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) {
    return {
      ok: false,
      failure: {
        kind: "malformed",
        detail: "one or more JWT segments are empty",
      },
    };
  }

  const expected = sign(`${header}.${payload}`, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);

  if (
    expectedBytes.byteLength !== actualBytes.byteLength ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    return {
      ok: false,
      failure: {
        kind: "signature_mismatch",
        detail:
          "HMAC-SHA256 signature does not match; token was not issued by this backend or AUTH_SESSION_SECRET has changed",
      },
    };
  }

  try {
    const parsed = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );

    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp <= now) {
      const expiryDate = new Date(parsed.exp * 1000).toISOString();
      return {
        ok: false,
        failure: {
          kind: "expired",
          detail: `token expired at ${expiryDate} (now=${now}, exp=${parsed.exp})`,
        },
      };
    }

    return { ok: true, claims: toOperatorSessionClaims(parsed) };
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: "parse_error",
        detail: `failed to parse or validate claims: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}