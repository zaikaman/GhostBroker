import { z } from "zod";
import type { Agent } from "./agent.js";
import type { NegotiationMandate } from "./negotiation.js";

export const hostedNegotiatorRuntimeConfigSchema = z.object({
  mandateId: z.string().uuid(),
  pollIntervalMs: z.number().int().positive().max(300_000),
  maxTicks: z.number().int().positive().max(10_000),
  dryRun: z.boolean().default(false),
});

export type HostedNegotiatorRuntimeConfig = z.infer<
  typeof hostedNegotiatorRuntimeConfigSchema
>;

export const createHostedAgentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentId: z.string().uuid(),
  config: hostedNegotiatorRuntimeConfigSchema,
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
  sessionExpiresAt: string | undefined;
  lastError: string | undefined;
  logTail: string;
}

export interface NegotiationMandateSummary {
  id: string;
  assetCode: string;
  side: NegotiationMandate["side"];
  targetQuantity: string;
  referencePrice: string;
  priceBandBps: number;
  maxNotional: string;
  urgency: NegotiationMandate["urgency"];
  deadline: string;
  disclosableClaims: string[];
  requiredCounterpartyClaims: Record<string, unknown>;
  counterpartyConstraints: Record<string, unknown>;
  operatorPrompt: string;
  policyHash: string;
  createdAt: string;
  updatedAt: string;
  // Authored AI-first policy summary (nullable for legacy mandates).
  objective: string | null;
  executionStyle: NegotiationMandate["executionStyle"];
  valuationPolicy: Record<string, unknown> | null;
  concessionPolicy: Record<string, unknown> | null;
  disclosurePolicy: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown> | null;
  counterpartyRequirements: Record<string, unknown> | null;
  sizePolicy: Record<string, unknown> | null;
  timeWindow: Record<string, unknown> | null;
  operatorInstructions: string | null;
  minimumQuantity: string | null;
  partialExecutionAllowed: boolean | null;
  // Derived rails summary.
  derivedAnchorValue: string | null;
  derivedWalkawayMin: string | null;
  derivedWalkawayMax: string | null;
  derivedConcessionBudgetBps: number | null;
  derivedNotionalCeiling: string | null;
}

export type HostedAgentMigrationState = "ready" | "needs_migration";

export interface HostedAgentRecord {
  agent: Agent;
  config: HostedNegotiatorRuntimeConfig | null;
  runtime: HostedAgentRuntimeStatus;
  mandate: NegotiationMandateSummary | null;
  migrationState: HostedAgentMigrationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readHostedNegotiatorRuntimeConfig(
  agent: Agent,
): HostedNegotiatorRuntimeConfig | null {
  const metadata = isRecord(agent.metadata) ? agent.metadata : null;
  const candidate = metadata?.hostedAgent;
  const parsed = hostedNegotiatorRuntimeConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function hasLegacyHostedAgentConfig(agent: Agent): boolean {
  const metadata = isRecord(agent.metadata) ? agent.metadata : null;
  const candidate = metadata?.hostedAgent;
  if (!isRecord(candidate)) {
    return false;
  }

  const legacyKeys = [
    "mode",
    "side",
    "assetCode",
    "quoteAssetCode",
    "operatorPrompt",
    "referencePrice",
    "priceBandBps",
    "quantityMin",
    "quantityMax",
    "tickIntervalMs",
    "label",
  ];

  return legacyKeys.some((key) => key in candidate);
}

export function toNegotiationMandateSummary(
  mandate: NegotiationMandate,
): NegotiationMandateSummary {
  return {
    id: mandate.id,
    assetCode: mandate.assetCode,
    side: mandate.side,
    targetQuantity: mandate.targetQuantity,
    referencePrice: mandate.referencePrice,
    priceBandBps: mandate.priceBandBps,
    maxNotional: mandate.maxNotional,
    urgency: mandate.urgency,
    deadline: mandate.deadline,
    disclosableClaims: mandate.disclosableClaims,
    requiredCounterpartyClaims: mandate.requiredCounterpartyClaims,
    counterpartyConstraints: mandate.counterpartyConstraints,
    operatorPrompt: mandate.operatorPrompt,
    policyHash: mandate.policyHash,
    createdAt: mandate.createdAt,
    updatedAt: mandate.updatedAt,
    objective: mandate.objective,
    executionStyle: mandate.executionStyle,
    valuationPolicy: mandate.valuationPolicy,
    concessionPolicy: mandate.concessionPolicy,
    disclosurePolicy: mandate.disclosurePolicy,
    approvalPolicy: mandate.approvalPolicy,
    counterpartyRequirements: mandate.counterpartyRequirements,
    sizePolicy: mandate.sizePolicy,
    timeWindow: mandate.timeWindow,
    operatorInstructions: mandate.operatorInstructions,
    minimumQuantity: mandate.minimumQuantity,
    partialExecutionAllowed: mandate.partialExecutionAllowed,
    derivedAnchorValue: mandate.derivedAnchorValue,
    derivedWalkawayMin: mandate.derivedWalkawayMin,
    derivedWalkawayMax: mandate.derivedWalkawayMax,
    derivedConcessionBudgetBps: mandate.derivedConcessionBudgetBps,
    derivedNotionalCeiling: mandate.derivedNotionalCeiling,
  };
}
