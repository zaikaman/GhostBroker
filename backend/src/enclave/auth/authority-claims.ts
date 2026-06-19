import { createHash } from "node:crypto";
import { z } from "zod";

export const authorityClaimSchema = z.object({
  agentDid: z.string().min(1),
  institutionId: z.string().uuid(),
  allowedActions: z.array(z.string().min(1)).min(1),
  instrumentScope: z.array(z.string().min(1)).min(1),
  directionScope: z.array(z.enum(["buy", "sell"])).min(1),
  maxNotionalMinorUnits: z.string().regex(/^\d+$/u),
  limitReference: z.string().min(1),
  validFrom: z.string().datetime(),
  expiresAt: z.string().datetime(),
  settlementScope: z.array(z.string().min(1)).min(1),
  revokedAt: z.string().datetime().optional(),
});

export type AuthorityClaim = z.infer<typeof authorityClaimSchema>;

export interface AuthorityCheckRequest {
  claim: AuthorityClaim;
  agentDid: string;
  institutionId: string;
  requestedAction: string;
  now?: Date;
}

export type AuthorityCheckFailure =
  | "agent_mismatch"
  | "institution_mismatch"
  | "action_not_allowed"
  | "not_yet_valid"
  | "expired"
  | "revoked";

export interface AuthorityCheckResult {
  valid: boolean;
  policyHash: string;
  failure?: AuthorityCheckFailure;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function computeAuthorityPolicyHash(claim: AuthorityClaim): string {
  return createHash("sha256").update(canonicalize(claim)).digest("hex");
}

export function parseAuthorityClaim(value: unknown): AuthorityClaim {
  return authorityClaimSchema.parse(value);
}

export function verifyAuthorityClaim(
  request: AuthorityCheckRequest,
): AuthorityCheckResult {
  const policyHash = computeAuthorityPolicyHash(request.claim);
  const now = request.now ?? new Date();

  if (request.claim.agentDid !== request.agentDid) {
    return { valid: false, policyHash, failure: "agent_mismatch" };
  }

  if (request.claim.institutionId !== request.institutionId) {
    return { valid: false, policyHash, failure: "institution_mismatch" };
  }

  if (!request.claim.allowedActions.includes(request.requestedAction)) {
    return { valid: false, policyHash, failure: "action_not_allowed" };
  }

  if (new Date(request.claim.validFrom).getTime() > now.getTime()) {
    return { valid: false, policyHash, failure: "not_yet_valid" };
  }

  if (new Date(request.claim.expiresAt).getTime() <= now.getTime()) {
    return { valid: false, policyHash, failure: "expired" };
  }

  if (request.claim.revokedAt) {
    return { valid: false, policyHash, failure: "revoked" };
  }

  return { valid: true, policyHash };
}
