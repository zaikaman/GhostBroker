import { z } from "zod";
import { agentDidSchema } from "./agent.js";

export const authChallengeRequestSchema = z.object({
  did: agentDidSchema,
});

export const authVerifyRequestSchema = z.object({
  challengeId: z.string().trim().min(1).max(128),
  did: agentDidSchema,
  signature: z.string().trim().min(1).max(512),
  walletAddress: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
});

export const authApiKeyRequestSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
});

export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;
export type AuthApiKeyRequest = z.infer<typeof authApiKeyRequestSchema>;

export interface AuthChallengeResponse {
  challengeId: string;
  challenge: string;
  expiresAt: string;
}

export interface AuthSessionResponse {
  token: string;
  expiresAt: string;
  institution: {
    id: string;
    displayName: string;
    t3TenantDid: string;
  };
}
