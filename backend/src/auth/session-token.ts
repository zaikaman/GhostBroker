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

/**
 * The raw JWT payload that is actually base64-encoded into the
 * token. The RLS policies under `database/policies/` read the
 * scope fields from `request.jwt.claims ->> '<key>'` (snake_case),
 * so the on-the-wire payload MUST use snake_case keys. The
 * `OperatorSessionClaims` interface above is the
 * TypeScript-friendly projection that all backend callers consume.
 *
 * Keeping these two shapes separate is what makes the JWT RLS-safe
 * (snake_case for Postgres) without forcing every TypeScript
 * caller to learn the Postgres convention.
 */
interface OperatorSessionJwtPayload {
  sub: string;
  did: string;
  institution_id: string;
  operator_id: string;
  wallet_address?: string;
  deposit_address?: string;
  iat: number;
  exp: number;
}

interface ParsedClaims {
  sub: string;
  did: string;
  institutionId: string;
  operatorId: string;
  walletAddress?: string;
  depositAddress?: string;
  iat: number;
  exp: number;
}

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

  // The JWT payload uses snake_case keys so that Postgres RLS
  // policies reading `request.jwt.claims ->> 'institution_id'`
  // (every policy in `database/policies/*.sql` does exactly
  // this) actually resolve the operator's institution. The
  // camelCase `OperatorSessionClaims` projection above is the
  // TypeScript-side surface every backend caller consumes; the
  // raw payload below is what gets base64-encoded into the JWT.
  const payload: OperatorSessionJwtPayload = {
    sub: claims.sub,
    did: claims.did,
    institution_id: claims.institutionId,
    operator_id: claims.operatorId,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (claims.walletAddress) {
    payload.wallet_address = claims.walletAddress;
  }
  if (claims.depositAddress) {
    payload.deposit_address = claims.depositAddress;
  }

  const header = encode({ alg: "HS256", typ: "JWT" });
  const payloadEncoded = encode(payload);
  const unsigned = `${header}.${payloadEncoded}`;
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

/**
 * Parse the raw JWT payload (snake_case keys, the shape we
 * actually encode into the token) and project it onto the
 * camelCase `OperatorSessionClaims` shape that every backend
 * caller consumes. The schema also accepts the legacy camelCase
 * keys (defensive decode) so any in-flight tokens issued before
 * the RLS-alignment fix still verify.
 */
const jwtPayloadSchema = z.object({
  sub: z.string().min(1),
  did: z.string().min(1),
  institution_id: z.string().uuid().optional(),
  institutionId: z.string().uuid().optional(),
  operator_id: z.string().min(1).optional(),
  operatorId: z.string().min(1).optional(),
  wallet_address: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{40}$/iu)
    .optional(),
  walletAddress: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{40}$/iu)
    .optional(),
  deposit_address: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{40}$/iu)
    .optional(),
  depositAddress: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{40}$/iu)
    .optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

function decodeJwtPayload(raw: unknown): ParsedClaims {
  const parsed = jwtPayloadSchema.parse(raw);
  const institutionId = parsed.institution_id ?? parsed.institutionId;
  const operatorId = parsed.operator_id ?? parsed.operatorId;
  const walletAddress = parsed.wallet_address ?? parsed.walletAddress;
  const depositAddress = parsed.deposit_address ?? parsed.depositAddress;
  if (!institutionId) {
    throw new Error(
      "missing required claim: institution_id (snake_case) or institutionId (legacy)",
    );
  }
  if (!operatorId) {
    throw new Error(
      "missing required claim: operator_id (snake_case) or operatorId (legacy)",
    );
  }
  const projected: ParsedClaims = {
    sub: parsed.sub,
    did: parsed.did,
    institutionId,
    operatorId,
    iat: parsed.iat,
    exp: parsed.exp,
  };
  if (walletAddress) {
    projected.walletAddress = walletAddress;
  }
  if (depositAddress) {
    projected.depositAddress = depositAddress;
  }
  return projected;
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
    const parsed = decodeJwtPayload(
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