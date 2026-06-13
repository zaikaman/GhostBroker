import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface OperatorSessionClaims {
  sub: string;
  did: string;
  institutionId: string;
  operatorId: string;
  walletAddress?: string;
  iat: number;
  exp: number;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  did: z.string().min(1),
  institutionId: z.string().uuid(),
  operatorId: z.string().min(1),
  walletAddress: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

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
  ttlSeconds?: number;
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: OperatorSessionClaims = {
    sub: params.did,
    did: params.did,
    institutionId: params.institutionId,
    operatorId: `did:${params.did}`,
    walletAddress: params.walletAddress,
    iat: issuedAt,
    exp: issuedAt + (params.ttlSeconds ?? 60 * 60 * 8),
  };
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode(claims);
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, params.secret)}`;
}

export function verifyOperatorSessionToken(
  token: string,
  secret: string,
): OperatorSessionClaims | undefined {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return undefined;
  }

  const header = parts[0]!;
  const payload = parts[1]!;
  const signature = parts[2]!;
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

    return parsed;
  } catch {
    return undefined;
  }
}
