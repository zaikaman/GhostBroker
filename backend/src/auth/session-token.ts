import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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
): OperatorSessionClaims | undefined {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return undefined;
  }

  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) {
    return undefined;
  }
  const expected = sign(`${header}.${payload}`, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);

  if (
    expectedBytes.byteLength !== actualBytes.byteLength ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    return undefined;
  }

  try {
    const parsed = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return undefined;
    }

    return toOperatorSessionClaims(parsed);
  } catch {
    return undefined;
  }
}