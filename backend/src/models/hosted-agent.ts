import { z } from "zod";
import type { Agent } from "./agent.js";

export const hostedAgentPresetSchema = z.enum(["buyer", "seller", "custom"]);
export type HostedAgentPreset = z.infer<typeof hostedAgentPresetSchema>;

export const hostedAgentConfigSchema = z.object({
  mode: hostedAgentPresetSchema.default("custom"),
  label: z.string().trim().min(1).max(100),
  side: z.enum(["buy", "sell"]),
  assetCode: z.string().trim().min(1).max(32),
  quoteAssetCode: z.string().trim().min(1).max(32).default("USDC"),
  operatorPrompt: z.string().trim().min(1).max(4_000),
  referencePrice: z.number().positive(),
  priceBandBps: z.number().int().positive().max(10_000),
  quantityMin: z.number().positive(),
  quantityMax: z.number().positive(),
  tickIntervalMs: z.number().int().positive().max(300_000),
  maxTicks: z.number().int().positive().max(10_000),
  dryRun: z.boolean().default(false),
  groqModel: z.string().trim().min(1).max(200).optional(),
});

export type HostedAgentConfig = z.infer<typeof hostedAgentConfigSchema>;

export const createHostedAgentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  config: hostedAgentConfigSchema.superRefine((value, ctx) => {
    if (value.quantityMax < value.quantityMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantityMax"],
        message: "quantityMax must be greater than or equal to quantityMin",
      });
    }
  }),
  startOnCreate: z.boolean().default(true),
});

export type CreateHostedAgentRequest = z.infer<typeof createHostedAgentRequestSchema>;

export const hostedAgentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type HostedAgentIdParams = z.infer<typeof hostedAgentIdParamsSchema>;

export const listHostedAgentsQuerySchema = z.object({
  running: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});

export interface HostedAgentRuntimeStatus {
  running: boolean;
  pid: number | undefined;
  startedAt: string | undefined;
  stoppedAt: string | undefined;
  lastExitCode: number | undefined;
  lastSignal: string | undefined;
  apiKeyId: string | undefined;
  lastError: string | undefined;
  logTail: string;
}

export interface HostedAgentRecord {
  agent: Agent;
  config: HostedAgentConfig;
  runtime: HostedAgentRuntimeStatus;
}

export function readHostedAgentConfig(agent: Agent): HostedAgentConfig | null {
  const candidate = (agent.metadata as Record<string, unknown> | undefined)?.hostedAgent;
  const parsed = hostedAgentConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

