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

export interface PendingIntent {
  correlationRef: string;
  institutionId: string;
  agentDid: string;
  intentHandle: string;
  executionRef: string;
  encryptedEnvelope: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  /** When this intent was added to the pending queue */
  sealedAt: string;
}
