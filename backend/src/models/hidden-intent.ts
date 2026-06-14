import { z } from "zod";
import { agentDidSchema } from "./agent.js";

export const encryptedIntentEnvelopeSchema = z
  .string()
  .trim()
  .min(32)
  .max(32768)
  .regex(/^[A-Za-z0-9._~:/+=-]+$/u);

export const settlementMetadataSchema = z.object({
  assetCode: z.string().trim().min(1).max(20).toUpperCase(),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().positive().finite(),
  price: z.number().positive().finite(),
});

export type SettlementMetadata = z.infer<typeof settlementMetadataSchema>;

export const hiddenIntentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  encryptedIntentEnvelope: encryptedIntentEnvelopeSchema,
  authorityRef: z.string().trim().min(8).max(512),
  settlementMetadata: settlementMetadataSchema,
});

export type HiddenIntentRequest = z.infer<typeof hiddenIntentRequestSchema>;

export type HiddenIntentState = "intent_sealed";

export interface HiddenIntentAccepted {
  intentHandle: string;
  state: HiddenIntentState;
}

/**
 * Body for `POST /api/agents/intents/cancel`.
 *
 * Cancels a previously submitted intent that is still pending in the
 * matching orchestrator. The caller is the same agent that submitted
 * the intent (authenticated via API key). Institution-scope is
 * enforced and the agent's admission must still be active.
 *
 * Operators who need to invalidate an agent's pending intents should
 * use `POST /api/agents/:id/revoke`, which cascades through
 * `MatchingOrchestrator.removeIntentsByAgent`.
 */
export const cancelIntentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  intentHandle: z.string().trim().min(1).max(256),
  authorityRef: z.string().trim().min(8).max(512),
});

export type CancelIntentRequest = z.infer<typeof cancelIntentRequestSchema>;

export interface IntentCancelled {
  intentHandle: string;
  state: "intent_cancelled";
}

export interface PendingIntent {
  correlationRef: string;
  institutionId: string;
  agentDid: string;
  intentHandle: string;
  executionRef: string;
  encryptedEnvelope: string;
  authorityRef: string;
  /**
   * The boundbuyer W3C VC the agent was admitted with, snapshotted
   * at submit time. The settlement command builder re-verifies
   * both the buyer and seller VCs from this field on every match.
   * The VC is also re-fetchable from the agent record by
   * `institutionId` + `agentDid`, but storing it on the intent
   * lets the orchestrator settle without an extra DB round-trip.
   */
  delegationCredential: unknown;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  /** When this intent was added to the pending queue */
  sealedAt: string;
  /** Agent authority limits — checked at matching time */
  instrumentScope?: string[];
  directionScope?: string[];
  maxNotional?: string;
}
