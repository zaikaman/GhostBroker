import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { DelegationCredential } from "@ghostbroker/agent-client";

/**
 * W3C Verifiable Credential — Node-side schema + helpers.
 *
 * Post-Phase 1: the backend mints + signs + persists the delegation VC
 * server-side. The agent process never holds or sends the VC. These
 * helpers remain in the agents workspace for:
 *   1. Parsing on-disk VCs for the legacy path (existing installations
 *      that still have `DELEGATION_CREDENTIAL_PATH` set).
 *   2. Time-window checks.
 *   3. Human-readable summaries.
 *
 * The canonical signer lives in `@ghostbroker/agent-client/src/delegation-signer.ts`.
 *
 * The `credentialSubject.allowedActions` enum is the
 * trading-agent action scope (the same `RequestedAgentAction`
 * enum the verifier and orchestrator use), not the procurement
 * BUIDL's `allowedCategories` enum. See
 * `t3-enclave/src/auth/ghostbroker-delegation.ts` for the full
 * rationale.
 */

const delegationActionScopeSchema = z.enum([
  "agent.admit",
  "intent.submit",
  "settlement.execute",
  "negotiation.open",
  "negotiation.move",
  "negotiation.disclose",
  "negotiation.settle",
]);

export const delegationSchema = z.object({
  id: z.string().min(1),
  type: z.array(z.string()).min(1),
  issuer: z.string().min(1),
  issuanceDate: z.string().min(1),
  expirationDate: z.string().min(1),
  credentialSubject: z.object({
    id: z.string().min(1),
    agentDid: z.string().min(1),
    maxSpendUsd: z.number().positive(),
    allowedActions: z.array(delegationActionScopeSchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string().min(1),
  }),
  proof: z
    .object({
      type: z.string().min(1),
      created: z.string().min(1),
      proofPurpose: z.string().min(1),
      verificationMethod: z.string().min(1),
      jws: z.string().optional(),
    })
    .optional(),
});

// Re-export the canonical type so existing imports keep working.
export type { DelegationCredential };

export function loadDelegationCredential(path: string): DelegationCredential {
  if (!existsSync(path)) {
    throw new Error(
      `Delegation credential not found at ${path}. Run setup:delegation first.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return delegationSchema.parse(raw);
}

export function isDelegationActive(
  credential: DelegationCredential,
  now = new Date(),
): boolean {
  const issued = new Date(credential.issuanceDate);
  const expires = new Date(credential.expirationDate);
  return now >= issued && now <= expires;
}

export function delegationSummary(credential: DelegationCredential): string {
  const { credentialSubject: subject } = credential;
  return [
    `Issuer: ${credential.issuer}`,
    `Agent: ${subject.agentDid}`,
    `Budget: $${subject.maxSpendUsd.toFixed(2)}`,
    `Actions: ${subject.allowedActions.join(", ")}`,
    `Valid until: ${credential.expirationDate}`,
    `Purpose: ${subject.purpose}`,
  ].join("\n");
}
