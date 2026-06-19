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
  "awaiting_approval",
  "converged",
  "settling",
  "settled",
  "walked_away",
  "expired",
]);

export const negotiationEscalationStatusSchema = z.enum([
  "none",
  "pending",
  "approved",
  "declined",
]);

export type NegotiationEscalationStatus = z.infer<
  typeof negotiationEscalationStatusSchema
>;
export const negotiationDistanceSignalSchema = z.enum([
  "crossed",
  "near",
  "moderate",
  "far",
]);

// ---------------------------------------------------------------------------
// Authored AI-first policy mandate (the operator-facing surface)
// ---------------------------------------------------------------------------

export const negotiationExecutionStyleSchema = z.enum([
  "patient",
  "balanced",
  "aggressive",
  "relationship_first",
  "trust_first",
]);

export const valuationPolicySchema = z.object({
  source: z.enum(["auto_anchor", "internal_fair_value", "operator_note"]),
  anchorValue: z.number().positive().optional(),
  note: z.string().trim().max(2000).optional(),
});

export const concessionPolicySchema = z.object({
  pace: z.enum(["patient", "balanced", "aggressive"]),
  maxConcessionBps: z.number().int().nonnegative().max(100000),
});

export const disclosurePolicySchema = z.object({
  allowLadder: z.array(z.string().trim().min(1).max(64)).max(32),
  requireReciprocityFor: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
});

export const approvalPolicySchema = z.object({
  mode: z.enum(["auto_settle", "escalate_outside_envelope"]),
  preferredEnvelopeNote: z.string().trim().max(2000).optional(),
});

export const sizePolicySchema = z.object({
  targetQuantity: z.number().positive(),
  minimumQuantity: z.number().nonnegative(),
  partialExecutionAllowed: z.boolean(),
});

export const timeWindowSchema = z.object({
  deadline: z.string().datetime(),
  preferredWindowStart: z.string().datetime().optional(),
  preferredWindowEnd: z.string().datetime().optional(),
});

export const counterpartyRequirementsSchema = z.object({
  requiredClaims: z.array(z.string().trim().min(1).max(64)).max(32),
  disallowedTraits: z.array(z.string().trim().min(1).max(64)).max(32),
  reputationTier: z.string().trim().max(64).optional(),
});

/**
 * The authored mandate. This is the ONLY operator-authored contract in
 * the primary flow. Numeric rails (reference_price, price_band_bps,
 * max_notional) are derived from this and are not authored here.
 */
export const authoredMandatePolicySchema = z.object({
  objective: z.string().trim().min(1).max(2000),
  assetCode: z.string().trim().min(1).max(32),
  side: negotiationSideSchema,
  sizePolicy: sizePolicySchema,
  urgency: negotiationUrgencySchema,
  executionStyle: negotiationExecutionStyleSchema,
  valuationPolicy: valuationPolicySchema,
  concessionPolicy: concessionPolicySchema,
  disclosurePolicy: disclosurePolicySchema,
  counterpartyRequirements: counterpartyRequirementsSchema,
  approvalPolicy: approvalPolicySchema,
  timeWindow: timeWindowSchema,
  operatorInstructions: z.string().trim().min(1).max(4000),
});

export type AuthoredMandatePolicyInput = z.infer<
  typeof authoredMandatePolicySchema
>;

/**
 * Legacy / derived-flavored mandate schema, kept for the compatibility
 * codepath (old mandates, admin/fallback intents). NOT the authored
 * surface. The strategy normalizer derives these fields from an
 * authored policy.
 */
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

/**
 * The public create-mandate request accepts EITHER the authored policy
 * (primary, AI-first) OR the legacy derived shape (compatibility). The
 * authored branch wins; the service normalizes it into derived rails
 * and persists both.
 */
export const createNegotiationMandateRequestSchema = z
  .object({
    mandate: negotiationMandateSchema.optional(),
    authored: authoredMandatePolicySchema.optional(),
  })
  .refine((value) => Boolean(value.authored || value.mandate), {
    message: "Either 'authored' policy or legacy 'mandate' is required.",
  });

export type CreateNegotiationMandateRequest = z.infer<
  typeof createNegotiationMandateRequestSchema
>;

export const createNegotiationTicketSchema = z.object({
  agentId: z.string().uuid(),
  agentDid: z.string().trim().min(1),
  policyHash: z.string().trim().min(1),
  assetCode: z.string().trim().min(1).max(32),
  side: negotiationSideSchema,
  compatibilityToken: z.string().trim().min(1).max(2048),
});

/**
 * Expanded move / decision contract. The LLM now declares strategic
 * intent, confidence, escalation, and settlement readiness — the
 * backend validates and bounds these. The legacy thin move fields
 * (action/price/quantity/claimType/reasoning) remain valid.
 */
export const strategicIntentSchema = z.enum([
  "open_patiently",
  "test_patience",
  "concede",
  "hold_for_better_terms",
  "build_trust",
  "request_proof",
  "accelerate_for_deadline",
  "accept",
  "walkaway",
]);

export const settlementReadinessSchema = z.enum([
  "not_ready",
  "near",
  "ready",
]);

export const negotiationMoveSchema = z.object({
  action: negotiationActionSchema,
  price: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  claimType: z.string().trim().min(1).max(64).optional(),
  strategicIntent: strategicIntentSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  escalationRequested: z.boolean().optional(),
  settlementReadiness: settlementReadinessSchema.optional(),
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

// ---------------------------------------------------------------------------
// Persisted records (snake_case DB rows)
// ---------------------------------------------------------------------------

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
  // Authored policy columns (nullable for legacy mandates).
  objective: string | null;
  execution_style: z.infer<typeof negotiationExecutionStyleSchema> | null;
  valuation_policy: Record<string, unknown> | null;
  concession_policy: Record<string, unknown> | null;
  disclosure_policy: Record<string, unknown> | null;
  approval_policy: Record<string, unknown> | null;
  counterparty_requirements: Record<string, unknown> | null;
  size_policy: Record<string, unknown> | null;
  time_window: Record<string, unknown> | null;
  operator_instructions: string | null;
  minimum_quantity: string | null;
  partial_execution_allowed: boolean | null;
  // Derived rails (nullable for legacy mandates).
  derived_anchor_value: string | null;
  derived_walkaway_min: string | null;
  derived_walkaway_max: string | null;
  derived_concession_budget_bps: number | null;
  derived_notional_ceiling: string | null;
  decision_meta: Record<string, unknown> | null;
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
  escalation_status: z.infer<typeof negotiationEscalationStatusSchema>;
  escalation_initiated_round_id: string | null;
  escalation_resolved_at: string | null;
  /**
   * Per-side Ghostbroker delegation W3C VCs snapshotted at
   * session creation (migration 018). The settlement command
   * builder re-verifies these VCs verbatim at settlement time.
   * Shape: `{ buy?: unknown, sell?: unknown }`. A `null` / missing
   * slot means the orchestrator never snapshotted a VC for that
   * side; the settlement command builder fails closed on null.
   */
  delegation_credentials: Record<string, unknown> | null;
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
  strategic_intent: string | null;
  confidence: number | null;
  escalation_requested: boolean | null;
  settlement_readiness: string | null;
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

// ---------------------------------------------------------------------------
// Domain objects (camelCase)
// ---------------------------------------------------------------------------

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
  // Authored policy (nullable for legacy mandates).
  objective: string | null;
  executionStyle: z.infer<typeof negotiationExecutionStyleSchema> | null;
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
  // Derived rails.
  derivedAnchorValue: string | null;
  derivedWalkawayMin: string | null;
  derivedWalkawayMax: string | null;
  derivedConcessionBudgetBps: number | null;
  derivedNotionalCeiling: string | null;
  decisionMeta: Record<string, unknown> | null;
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
  /** Opaque strategic intent declared by the agent for this move. */
  strategicIntent: string | null;
  confidence: number | null;
  escalationRequested: boolean | null;
  settlementReadiness: string | null;
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
  /** Trust / disclosure milestone state, opaque labels only. */
  trustLevel: "none" | "partial" | "established";
  disclosureProgress: {
    requiredClaims: string[];
    receivedVerifiedClaims: string[];
    pendingRequiredClaims: string[];
  };
  /** Authoritative escalation state. `escalationPending` is the
   * shorthand for "the gate is closed"; the underlying `escalationStatus`
   * carries the full lifecycle (none → pending → approved | declined). */
  escalationStatus: z.infer<typeof negotiationEscalationStatusSchema>;
  escalationPending: boolean;
  /** Free-text reason the agent attached when it triggered the gate. */
  escalationReason: string | null;
  /** Latest opaque strategy signal surfaced for "why the AI matters". */
  latestStrategySignal: string | null;
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
    objective: record.objective,
    executionStyle: record.execution_style,
    valuationPolicy: record.valuation_policy,
    concessionPolicy: record.concession_policy,
    disclosurePolicy: record.disclosure_policy,
    approvalPolicy: record.approval_policy,
    counterpartyRequirements: record.counterparty_requirements,
    sizePolicy: record.size_policy,
    timeWindow: record.time_window,
    operatorInstructions: record.operator_instructions,
    minimumQuantity: record.minimum_quantity,
    partialExecutionAllowed: record.partial_execution_allowed,
    derivedAnchorValue: record.derived_anchor_value,
    derivedWalkawayMin: record.derived_walkaway_min,
    derivedWalkawayMax: record.derived_walkaway_max,
    derivedConcessionBudgetBps: record.derived_concession_budget_bps,
    derivedNotionalCeiling: record.derived_notional_ceiling,
    decisionMeta: record.decision_meta,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
