import { z } from "zod";

export const institutionStatusSchema = z.enum([
  "pending",
  "active",
  "suspended",
  "closed",
]);

export type InstitutionStatus = z.infer<typeof institutionStatusSchema>;

/**
 * WS3: settlement profile refs the system understands.
 *   - `chain:sepolia:erc20` — Sepolia ERC-20 chain rail.
 *                             GhostBroker's only settlement rail.
 *
 * The chain rail's metadata must include `tokenAddresses`
 * (a `Record<assetCode, erc20Address>` map). The
 * `depositAddress` is optional at request time because the
 * backend can derive and manage a per-institution deposit
 * wallet automatically when the server-owned wallet mode
 * is enabled. When supplied, it must still be a valid
 * Ethereum address.
 *
 * The legacy `wallet:default` noop profile has been removed:
 * there is no longer a noop fallback, and every settlement
 * must round-trip through the chain rail.
 */
export const SUPPORTED_SETTLEMENT_PROFILE_REFS = [
  "chain:sepolia:erc20",
] as const;

export const SUPPORTED_SETTLEMENT_PROFILE_REFS_REGEX = /^(chain:sepolia:erc20|settlement-profile:[a-z0-9_:-]+)$/u;

const ethereumAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/u, "must be a 0x-prefixed 40-hex address");

/**
 * WS3: the metadata shape for institutions on the chain
 * rail. For the chain rail, `tokenAddresses` is required
 * and `depositAddress` is optional. For other rails, the
 * metadata is free-form.
 */
const chainRailMetadataShape = z
  .object({
    depositAddress: ethereumAddressSchema.optional(),
    tokenAddresses: z.record(z.string(), ethereumAddressSchema),
  })
  .strict();

export const createInstitutionRequestSchema = z
  .object({
    legalName: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(128),
    settlementProfileRef: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(SUPPORTED_SETTLEMENT_PROFILE_REFS_REGEX, "unsupported settlement profile ref"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.settlementProfileRef !== "chain:sepolia:erc20") {
      return;
    }
    const parsed = chainRailMetadataShape.safeParse(value.metadata ?? {});
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["metadata", ...issue.path],
      });
    }
  });

export type CreateInstitutionRequest = z.infer<
  typeof createInstitutionRequestSchema
>;

/**
 * WS3: PATCH /api/institutions/:id request shape. Allows
 * updating the settlement profile and/or the chain-rail
 * metadata without recreating the institution. Profile
 * changes are gated by the same chain-rail superRefine as
 * create.
 */
export const updateInstitutionRequestSchema = z
  .object({
    settlementProfileRef: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(SUPPORTED_SETTLEMENT_PROFILE_REFS_REGEX, "unsupported settlement profile ref")
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.settlementProfileRef !== "chain:sepolia:erc20") {
      return;
    }
    const parsed = chainRailMetadataShape.safeParse(value.metadata ?? {});
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["metadata", ...issue.path],
      });
    }
  });

export type UpdateInstitutionRequest = z.infer<
  typeof updateInstitutionRequestSchema
>;

export interface Institution {
  id: string;
  legalName: string;
  displayName: string;
  status: InstitutionStatus;
  t3TenantDid: string;
  settlementProfileRef: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface InstitutionRecord {
  id: string;
  legal_name: string;
  display_name: string;
  status: InstitutionStatus;
  t3_tenant_did: string;
  settlement_profile_ref: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export function institutionFromRecord(record: InstitutionRecord): Institution {
  return {
    id: record.id,
    legalName: record.legal_name,
    displayName: record.display_name,
    status: record.status,
    t3TenantDid: record.t3_tenant_did,
    settlementProfileRef: record.settlement_profile_ref,
    metadata: record.metadata,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
