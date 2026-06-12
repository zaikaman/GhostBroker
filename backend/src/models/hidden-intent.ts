import { z } from "zod";
import { agentDidSchema } from "./agent.js";

export const encryptedIntentEnvelopeSchema = z
  .string()
  .trim()
  .min(32)
  .max(32768)
  .regex(/^[A-Za-z0-9._~:/+=-]+$/u);

export const hiddenIntentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  encryptedIntentEnvelope: encryptedIntentEnvelopeSchema,
  authorityRef: z.string().trim().min(8).max(512),
});

export type HiddenIntentRequest = z.infer<typeof hiddenIntentRequestSchema>;

export type HiddenIntentState = "intent_sealed";

export interface HiddenIntentAccepted {
  intentHandle: string;
  state: HiddenIntentState;
}
