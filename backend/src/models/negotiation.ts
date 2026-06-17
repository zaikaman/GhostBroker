import { z } from "zod";

const jsonValueSchema: z.ZodType<
  string | number | boolean | null | Record<string, unknown> | unknown[]
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const negotiationUrgencySchema = z.enum([
  "low",
  "normal",
  "high",
  "critical",
]);
export const negotiationSideSchema = z.enum(["buy", "sell"]);
export const negotiationActionSchema = z.enum([
  "propose",
  "counter",
  "reveal",
  "request_disclosure",
  "accept",
  "hold",
  "walkaway",
]);
export const negotiationSessionStatusSchema = z.enum([
  "pairing",
  "active",
  "converged",
  "settling",
  "settled",
  "walked_away",
  "expired",
]);
export const negotiationDistanceSignalSchema = z.enum([
  "crossed",
  "near",
  "moderate",
  "far",
]);

export const negotiationMandateSchema = z.object({
  assetCode: z.string().trim().min(1).max(32),
  side: negotiationSideSchema,
  targetQuantity: z.number().positive(),
  referencePrice: z.number().positive(),
  priceBandBps: z.number().int().nonnegative().max(100000),
  deadline: z.string().datetime(),
  urgency: negotiationUrgencySchema,
  maxNotional: z.string().regex(/^\d+(?:\.\d+)?$/u),
  disclosableClaims: z.array(z.string().trim().min(1).max(64)).max(32),
  requiredCounterpartyClaims: z.record(z.string(), jsonValueSchema),
  counterpartyConstraints: z.record(z.string(), jsonValueSchema),
  operatorPrompt: z.string().trim().min(1).max(4000),
});

export type NegotiationMandateInput = z.infer<typeof negotiationMandateSchema>;

export const createNegotiationMandateRequestSchema = z.object({
  mandate: negotiationMandateSchema,
});

export const createNegotiationTicketSchema = z.object({
  agentId: z.string().uuid(),
  agentDid: z.string().trim().min(1),
  policyHash: z.string().trim().min(1),
  assetCode: z.string().trim().min(1).max(32),
  side: negotiationSideSchema,
  compatibilityToken: z.string().trim().min(1).max(2048),
});

export const negotiationMoveSchema = z.object({
  action: negotiationActionSchema,
  price: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  claimType: z.string().trim().min(1).max(64).optional(),
  reasoning: z.string().trim().min(1).max(4000),
});

export type NegotiationMove = z.infer<typeof negotiationMoveSchema>;

export const submitNegotiationMoveSchema = z.object({
  agentId: z.string().uuid(),
  agentDid: z.string().trim().min(1),
  authorityRef: z.string().trim().min(1),
  move: negotiationMoveSchema,
  claimCredential: z.unknown().optional(),
});

export const walkawayNegotiationSchema = z.object({
  agentId: z.string().uuid(),
  agentDid: z.string().trim().min(1),
  authorityRef: z.string().trim().min(1),
  reasoning: z.string().trim().min(1).max(4000).optional(),
});

export interface NegotiationMandateRecord {
  id: string;
  institution_id: string;
  agent_id: string;
  agent_did: string;
  asset_code: string;
  side: z.infer<typeof negotiationSideSchema>;
  target_quantity: string;
  reference_price: string;
  price_band_bps: number;
  deadline: string;
  urgency: z.infer<typeof negotiationUrgencySchema>;
  max_notional: string;
  disclosable_claims: string[];
  required_counterparty_claims: Record<string, unknown>;
  counterparty_constraints: Record<string, unknown>;
  operator_prompt: string;
  policy_hash: string;
  created_at: string;
  updated_at: string;
}

export interface NegotiationSessionRecord {
  id: string;
  asset_code: string;
  buy_institution_id: string;
  sell_institution_id: string;
  buy_agent_did: string;
  sell_agent_did: string;
  buy_mandate_id: string;
  sell_mandate_id: string;
  status: z.infer<typeof negotiationSessionStatusSchema>;
  current_turn: z.infer<typeof negotiationSideSchema>;
  round_number: number;
  max_rounds: number;
  deadline: string;
  trade_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface NegotiationRoundRecord {
  id: string;
  session_id: string;
  round_number: number;
  actor_did: string;
  actor_side: z.infer<typeof negotiationSideSchema>;
  move_type: z.infer<typeof negotiationActionSchema>;
  proposal_ciphertext: string | null;
  disclosed_claim_refs: string[];
  opaque_signal: string | null;
  reasoning: string | null;
  created_at: string;
}

export interface NegotiationDisclosureRecord {
  id: string;
  session_id: string;
  from_did: string;
  from_side: z.infer<typeof negotiationSideSchema>;
  claim_type: string;
  claim_assertion_ciphertext: string;
  verified: boolean;
  t3_attestation_ref: string;
  created_at: string;
}

export interface NegotiationMandate {
  id: string;
  institutionId: string;
  agentId: string;
  agentDid: string;
  assetCode: string;
  side: z.infer<typeof negotiationSideSchema>;
  targetQuantity: string;
  referencePrice: string;
  priceBandBps: number;
  deadline: string;
  urgency: z.infer<typeof negotiationUrgencySchema>;
  maxNotional: string;
  disclosableClaims: string[];
  requiredCounterpartyClaims: Record<string, unknown>;
  counterpartyConstraints: Record<string, unknown>;
  operatorPrompt: string;
  policyHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface NegotiationRoundView {
  id: string;
  roundNumber: number;
  actorDid: string;
  actorSide: z.infer<typeof negotiationSideSchema>;
  moveType: z.infer<typeof negotiationActionSchema>;
  disclosedClaimRefs: string[];
  opaqueSignal: z.infer<typeof negotiationDistanceSignalSchema> | null;
  reasoning: string | null;
  createdAt: string;
}

export interface NegotiationDisclosureView {
  id: string;
  fromDid: string;
  fromSide: z.infer<typeof negotiationSideSchema>;
  claimType: string;
  verified: boolean;
  t3AttestationRef: string;
  createdAt: string;
}

export interface RedactedNegotiationSessionView {
  id: string;
  assetCode: string;
  status: z.infer<typeof negotiationSessionStatusSchema>;
  currentTurn: z.infer<typeof negotiationSideSchema>;
  roundNumber: number;
  maxRounds: number;
  deadline: string;
  tradeRef: string | null;
  counterpartStandingProposal: {
    price: number | null;
    quantity: number | null;
  };
  distanceSignal: z.infer<typeof negotiationDistanceSignalSchema> | null;
  disclosedClaims: NegotiationDisclosureView[];
  rounds: NegotiationRoundView[];
  createdAt: string;
  updatedAt: string;
}

export function negotiationMandateFromRecord(
  record: NegotiationMandateRecord,
): NegotiationMandate {
  return {
    id: record.id,
    institutionId: record.institution_id,
    agentId: record.agent_id,
    agentDid: record.agent_did,
    assetCode: record.asset_code,
    side: record.side,
    targetQuantity: record.target_quantity,
    referencePrice: record.reference_price,
    priceBandBps: record.price_band_bps,
    deadline: record.deadline,
    urgency: record.urgency,
    maxNotional: record.max_notional,
    disclosableClaims: record.disclosable_claims,
    requiredCounterpartyClaims: record.required_counterparty_claims,
    counterpartyConstraints: record.counterparty_constraints,
    operatorPrompt: record.operator_prompt,
    policyHash: record.policy_hash,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
