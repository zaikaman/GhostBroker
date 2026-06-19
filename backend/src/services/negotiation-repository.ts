import { PublicError } from "../errors/public-error.js";
import {
  negotiationMandateFromRecord,
  type NegotiationDisclosureRecord,
  type NegotiationMandate,
  type NegotiationMandateInput,
  type NegotiationMandateRecord,
  type NegotiationRoundRecord,
  type NegotiationSessionRecord,
  type RedactedNegotiationSessionView,
} from "../models/negotiation.js";
import type {
  AuthoredMandatePolicy,
  DerivedExecutionRails,
} from "./negotiation-strategy.js";

interface QueryResult<TResult> {
  data: TResult[] | null;
  error: Error | null;
}

interface QueryChain<TResult> extends PromiseLike<QueryResult<TResult>> {
  eq(column: string, value: string): QueryChain<TResult>;
  in(column: string, values: readonly string[]): QueryChain<TResult>;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): QueryChain<TResult>;
  single(): Promise<{ data: TResult | null; error: Error | null }>;
}

interface SelectQuery<TResult> {
  select(columns?: string): QueryChain<TResult>;
}

interface InsertResult<TResult> {
  single(): Promise<{ data: TResult | null; error: Error | null }>;
}

interface InsertQuery<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): InsertResult<TResult>;
  };
}

interface DeleteResult {
  error: Error | null;
}

interface DeleteQuery {
  delete(): {
    eq(column: string, value: string): {
      eq(column: string, value: string): Promise<DeleteResult>;
    };
  };
}

interface UpdateQuery<TResult> {
  update(value: Record<string, unknown>): {
    eq(column: string, value: string): {
      select(columns?: string): {
        single(): Promise<{ data: TResult | null; error: Error | null }>;
      };
    } & Promise<DeleteResult>;
  };
}

interface SupabaseNegotiationClient {
  from(table: "negotiation_mandates"): InsertQuery<NegotiationMandateRecord> &
    SelectQuery<NegotiationMandateRecord> &
    UpdateQuery<NegotiationMandateRecord> &
    DeleteQuery;
  from(table: "negotiation_sessions"): InsertQuery<NegotiationSessionRecord> &
    SelectQuery<NegotiationSessionRecord> &
    UpdateQuery<NegotiationSessionRecord>;
  from(table: "negotiation_rounds"): InsertQuery<NegotiationRoundRecord> &
    SelectQuery<NegotiationRoundRecord>;
  from(table: "negotiation_disclosures"): InsertQuery<NegotiationDisclosureRecord> &
    SelectQuery<NegotiationDisclosureRecord>;
  from(table: "agents"): SelectQuery<{
    metadata: Record<string, unknown> | null;
  }>;
  from(table: "completed_trades"): UpdateQuery<{ id: string }>;
}

export interface CreateMandateRepositoryInput {
  institutionId: string;
  agentId: string;
  agentDid: string;
  policyHash: string;
  /**
   * The authored AI-first policy (primary). When present, the derived
   * rails are also persisted alongside it.
   */
  authored?: AuthoredMandatePolicy;
  rails?: DerivedExecutionRails;
  /**
   * Legacy / compatibility derived-flavored mandate. Used when an old
   * client posts the thin derived shape directly. The authored surface
   * wins when both are present.
   */
  legacy?: NegotiationMandateInput;
}

export interface NegotiationRepository {
  createMandate(input: CreateMandateRepositoryInput): Promise<NegotiationMandate>;
  getMandateByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate | null>;
  listMandatesByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate[]>;
  getMandateById(
    mandateId: string,
    institutionId: string,
  ): Promise<NegotiationMandate | null>;
  getSessionRecord(sessionId: string): Promise<NegotiationSessionRecord | null>;
  /**
   * Snapshot a per-side Ghostbroker delegation W3C VC onto the
   * session at open time. The snapshot is the authoritative VC
   * the settlement command builder re-verifies at settlement
   * time, so a later "Regenerate Delegation" re-mint or a
   * transient DB error in the agent-record lookup cannot change
   * which credential the orchestrator settles against.
   *
   * The implementation MUST be idempotent: the orchestrator
   * may snapshot the same VC more than once across the open /
   * move / disclose calls.
   */
  setSessionDelegation(input: {
    sessionId: string;
    side: "buy" | "sell";
    delegationCredential: unknown;
  }): Promise<void>;
  /**
   * Return the per-side delegation VC the orchestrator
   * snapshotted at session creation. Returns `null` when the
   * slot was never populated (legacy session, or the orchestrator
   * failed to snapshot). The settlement command builder treats
   * `null` as a hard fail.
   */
  getSessionDelegation(
    sessionId: string,
    side: "buy" | "sell",
  ): Promise<{ id: string } & Record<string, unknown> | null>;
  linkSettledTrade(sessionId: string, tradeRef: string): Promise<void>;
  createSession(input: {
    assetCode: string;
    buyInstitutionId: string;
    sellInstitutionId: string;
    buyAgentDid: string;
    sellAgentDid: string;
    buyMandateId: string;
    sellMandateId: string;
    currentTurn: "buy" | "sell";
    maxRounds: number;
    deadline: string;
  }): Promise<NegotiationSessionRecord>;
  updateSession(input: {
    sessionId: string;
    patch: Partial<
      Pick<
        NegotiationSessionRecord,
        | "status"
        | "current_turn"
        | "round_number"
        | "trade_ref"
        | "deadline"
        | "escalation_status"
        | "escalation_initiated_round_id"
        | "escalation_resolved_at"
      >
    >;
  }): Promise<NegotiationSessionRecord>;
  /**
   * Return the most recent standing proposal (price+quantity) per
   * side that has not been superseded by a walkaway/expiry. Used by
   * the orchestrator to re-evaluate a cross after the operator
   * approves an escalation.
   */
  getStandingProposals(sessionId: string): Promise<{
    buy: { price: number; quantity: number } | null;
    sell: { price: number; quantity: number } | null;
  }>;
  appendRound(input: {
    sessionId: string;
    roundNumber: number;
    actorDid: string;
    actorSide: "buy" | "sell";
    moveType: NegotiationRoundRecord["move_type"];
    proposalCiphertext?: string | null;
    disclosedClaimRefs?: string[];
    opaqueSignal?: string | null;
    reasoning?: string | null;
    strategicIntent?: string | null;
    confidence?: number | null;
    escalationRequested?: boolean | null;
    settlementReadiness?: string | null;
  }): Promise<NegotiationRoundRecord>;
  appendDisclosure(input: {
    sessionId: string;
    fromDid: string;
    fromSide: "buy" | "sell";
    claimType: string;
    claimAssertionCiphertext: string;
    verified: boolean;
    t3AttestationRef: string;
  }): Promise<NegotiationDisclosureRecord>;
  listSessions(
    institutionId: string,
    agentDid?: string,
  ): Promise<RedactedNegotiationSessionView[]>;
  getSession(
    sessionId: string,
    institutionId: string,
  ): Promise<RedactedNegotiationSessionView | null>;
}

function parseProposalCiphertext(
  ciphertext: string | null,
): { price: number | null; quantity: number | null } {
  if (!ciphertext) {
    return { price: null, quantity: null };
  }
  try {
    const decoded = Buffer.from(ciphertext, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { price?: unknown; quantity?: unknown };
    return {
      price: typeof parsed.price === "number" ? parsed.price : null,
      quantity: typeof parsed.quantity === "number" ? parsed.quantity : null,
    };
  } catch {
    return { price: null, quantity: null };
  }
}

function pickLatestStandingProposal(
  rounds: NegotiationRoundRecord[],
  side: "buy" | "sell",
): { price: number; quantity: number } | null {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const round = rounds[i];
    if (!round) continue;
    if (round.actor_side !== side) continue;
    if (
      round.move_type !== "propose" &&
      round.move_type !== "counter" &&
      round.move_type !== "accept" &&
      round.move_type !== "request_disclosure" &&
      round.move_type !== "reveal" &&
      round.move_type !== "hold"
    ) {
      continue;
    }
    const parsed = parseProposalCiphertext(round.proposal_ciphertext);
    if (parsed.price !== null && parsed.quantity !== null) {
      return { price: parsed.price, quantity: parsed.quantity };
    }
  }
  return null;
}

function toRoundView(record: NegotiationRoundRecord): RedactedNegotiationSessionView["rounds"][number] {
  const opaqueSignal =
    record.opaque_signal === "crossed" ||
    record.opaque_signal === "near" ||
    record.opaque_signal === "moderate" ||
    record.opaque_signal === "far"
      ? record.opaque_signal
      : null;

  return {
    id: record.id,
    roundNumber: record.round_number,
    actorDid: record.actor_did,
    actorSide: record.actor_side,
    moveType: record.move_type,
    disclosedClaimRefs: record.disclosed_claim_refs,
    opaqueSignal,
    reasoning: record.reasoning,
    strategicIntent: record.strategic_intent ?? null,
    confidence: record.confidence ?? null,
    escalationRequested: record.escalation_requested ?? null,
    settlementReadiness: record.settlement_readiness ?? null,
    createdAt: record.created_at,
  };
}

function toDisclosureView(record: NegotiationDisclosureRecord) {
  return {
    id: record.id,
    fromDid: record.from_did,
    fromSide: record.from_side,
    claimType: record.claim_type,
    verified: record.verified,
    t3AttestationRef: record.t3_attestation_ref,
    createdAt: record.created_at,
  };
}

export class SupabaseNegotiationRepository implements NegotiationRepository {
  private readonly client: SupabaseNegotiationClient;

  public constructor(client: SupabaseNegotiationClient) {
    this.client = client;
  }

  public async createMandate(
    input: CreateMandateRepositoryInput,
  ): Promise<NegotiationMandate> {
    const { authored, rails, legacy } = input;

    // Replace semantics: UPDATE any existing mandate for this agent
    // instead of deleting it. The mandate row is referenced from
    // `negotiation_sessions.buy_mandate_id` /
    // `negotiation_sessions.sell_mandate_id` (audit trail for past
    // sessions), so a hard DELETE trips the foreign-key constraint.
    // The schema's `uniq_negotiation_mandates_agent_active` unique
    // index guarantees there is at most one row per agent, so this
    // update is unambiguous; if no row exists, we INSERT a fresh one.
    const existing = await this.listMandatesByAgent(
      input.institutionId,
      input.agentId,
    );

    // Resolve the persisted row. The authored policy is primary; the
    // derived rails feed the legacy numeric columns so the enclave/
    // contract authority path keeps working unchanged.
    const updateRow: Record<string, unknown> = {
      institution_id: input.institutionId,
      agent_id: input.agentId,
      agent_did: input.agentDid,
      policy_hash: input.policyHash,
    };

    if (authored && rails) {
      updateRow.asset_code = authored.assetCode;
      updateRow.side = authored.side;
      updateRow.target_quantity = rails.targetQuantity;
      updateRow.reference_price = rails.referencePrice;
      updateRow.price_band_bps = rails.priceBandBps;
      updateRow.deadline = authored.timeWindow.deadline;
      updateRow.urgency = authored.urgency;
      updateRow.max_notional = rails.notionalCeiling.toString();
      updateRow.disclosable_claims = authored.disclosurePolicy.allowLadder;
      updateRow.required_counterparty_claims =
        authored.counterpartyRequirements.requiredClaims.length > 0
          ? Object.fromEntries(
              authored.counterpartyRequirements.requiredClaims.map((claim) => [
                claim,
                true,
              ]),
            )
          : {};
      updateRow.counterparty_constraints = {
        disallowedTraits: authored.counterpartyRequirements.disallowedTraits,
        reputationTier: authored.counterpartyRequirements.reputationTier ?? null,
      };
      updateRow.operator_prompt = authored.operatorInstructions;
      // Authored columns.
      updateRow.objective = authored.objective;
      updateRow.execution_style = authored.executionStyle;
      updateRow.valuation_policy = authored.valuationPolicy;
      updateRow.concession_policy = authored.concessionPolicy;
      updateRow.disclosure_policy = authored.disclosurePolicy;
      updateRow.approval_policy = authored.approvalPolicy;
      updateRow.counterparty_requirements = authored.counterpartyRequirements;
      updateRow.size_policy = authored.sizePolicy;
      updateRow.time_window = authored.timeWindow;
      updateRow.operator_instructions = authored.operatorInstructions;
      updateRow.minimum_quantity = rails.minimumQuantity;
      updateRow.partial_execution_allowed = rails.partialExecutionAllowed;
      // Derived rails.
      updateRow.derived_anchor_value = rails.anchorValue;
      updateRow.derived_walkaway_min = rails.walkawayMin;
      updateRow.derived_walkaway_max = rails.walkawayMax;
      updateRow.derived_concession_budget_bps = rails.concessionBudgetBps;
      updateRow.derived_notional_ceiling = rails.notionalCeiling;
    } else if (legacy) {
      updateRow.asset_code = legacy.assetCode;
      updateRow.side = legacy.side;
      updateRow.target_quantity = legacy.targetQuantity;
      updateRow.reference_price = legacy.referencePrice;
      updateRow.price_band_bps = legacy.priceBandBps;
      updateRow.deadline = legacy.deadline;
      updateRow.urgency = legacy.urgency;
      updateRow.max_notional = legacy.maxNotional;
      updateRow.disclosable_claims = legacy.disclosableClaims;
      updateRow.required_counterparty_claims = legacy.requiredCounterpartyClaims;
      updateRow.counterparty_constraints = legacy.counterpartyConstraints;
      updateRow.operator_prompt = legacy.operatorPrompt;
    } else {
      throw new PublicError(
        "validation_failed",
        400,
        undefined,
        "Mandate create requires either an authored policy or legacy mandate fields.",
      );
    }

    const live = existing[0];
    if (live) {
      const { data, error } = await this.client
        .from("negotiation_mandates")
        .update(updateRow)
        .eq("id", live.id)
        .select("*")
        .single();

      if (error || !data) {
        throw new PublicError("service_unavailable", 503, error);
      }
      return negotiationMandateFromRecord(data);
    }

    const { data, error } = await this.client
      .from("negotiation_mandates")
      .insert(updateRow)
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return negotiationMandateFromRecord(data);
  }

  public async getMandateByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate | null> {
    const mandates = await this.listMandatesByAgent(institutionId, agentId);
    return mandates[0] ?? null;
  }

  public async listMandatesByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate[]> {
    const { data, error } = await this.client
      .from("negotiation_mandates")
      .select("*")
      .eq("institution_id", institutionId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map(negotiationMandateFromRecord);
  }

  public async getMandateById(
    mandateId: string,
    institutionId: string,
  ): Promise<NegotiationMandate | null> {
    const { data, error } = await this.client
      .from("negotiation_mandates")
      .select("*")
      .eq("id", mandateId)
      .eq("institution_id", institutionId)
      .single();

    if (error || !data) {
      return null;
    }
    return negotiationMandateFromRecord(data);
  }

  public async getSessionRecord(
    sessionId: string,
  ): Promise<NegotiationSessionRecord | null> {
    const { data, error } = await this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (error || !data) {
      return null;
    }
    return data;
  }

  public async getSessionDelegation(
    sessionId: string,
    side: "buy" | "sell",
  ): Promise<({ id: string } & Record<string, unknown>) | null> {
    const session = await this.getSessionRecord(sessionId);
    if (!session) {
      return null;
    }
    const snapshot = (session.delegation_credentials ?? {}) as Record<
      string,
      unknown
    >;
    const credential = snapshot[side];
    if (!credential || typeof credential !== "object") {
      return null;
    }
    const typed = credential as { id?: unknown } & Record<string, unknown>;
    if (typeof typed.id !== "string") {
      return null;
    }
    return typed as { id: string } & Record<string, unknown>;
  }

  public async setSessionDelegation(input: {
    sessionId: string;
    side: "buy" | "sell";
    delegationCredential: unknown;
  }): Promise<void> {
    const existing = await this.getSessionRecord(input.sessionId);
    if (!existing) {
      throw new PublicError("not_found", 404);
    }
    const snapshot = {
      ...(existing.delegation_credentials ?? {}),
      [input.side]: input.delegationCredential,
    };
    const { error } = await this.client
      .from("negotiation_sessions")
      .update({ delegation_credentials: snapshot })
      .eq("id", input.sessionId);
    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }

  public async linkSettledTrade(
    sessionId: string,
    tradeRef: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("completed_trades")
      .update({ negotiation_session_id: sessionId })
      .eq("rail_trade_ref", tradeRef)
      .select("id")
      .single();

    if (error) {
      return;
    }
  }

  public async createSession(input: {
    assetCode: string;
    buyInstitutionId: string;
    sellInstitutionId: string;
    buyAgentDid: string;
    sellAgentDid: string;
    buyMandateId: string;
    sellMandateId: string;
    currentTurn: "buy" | "sell";
    maxRounds: number;
    deadline: string;
  }): Promise<NegotiationSessionRecord> {
    const { data, error } = await this.client
      .from("negotiation_sessions")
      .insert({
        asset_code: input.assetCode,
        buy_institution_id: input.buyInstitutionId,
        sell_institution_id: input.sellInstitutionId,
        buy_agent_did: input.buyAgentDid,
        sell_agent_did: input.sellAgentDid,
        buy_mandate_id: input.buyMandateId,
        sell_mandate_id: input.sellMandateId,
        status: "active",
        current_turn: input.currentTurn,
        round_number: 0,
        max_rounds: input.maxRounds,
        deadline: input.deadline,
        escalation_status: "none",
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return data;
  }

  public async updateSession(input: {
    sessionId: string;
    patch: Partial<
      Pick<
        NegotiationSessionRecord,
        | "status"
        | "current_turn"
        | "round_number"
        | "trade_ref"
        | "deadline"
        | "escalation_status"
        | "escalation_initiated_round_id"
        | "escalation_resolved_at"
      >
    >;
  }): Promise<NegotiationSessionRecord> {
    const { data, error } = await this.client
      .from("negotiation_sessions")
      .update(input.patch)
      .eq("id", input.sessionId)
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return data;
  }

  public async getStandingProposals(sessionId: string): Promise<{
    buy: { price: number; quantity: number } | null;
    sell: { price: number; quantity: number } | null;
  }> {
    const { data: rounds, error } = await this.client
      .from("negotiation_rounds")
      .select("*")
      .eq("session_id", sessionId)
      .order("round_number", { ascending: true });
    if (error || !rounds) {
      return { buy: null, sell: null };
    }
    const buy = pickLatestStandingProposal(rounds, "buy");
    const sell = pickLatestStandingProposal(rounds, "sell");
    return { buy, sell };
  }

  public async appendRound(input: {
    sessionId: string;
    roundNumber: number;
    actorDid: string;
    actorSide: "buy" | "sell";
    moveType: NegotiationRoundRecord["move_type"];
    proposalCiphertext?: string | null;
    disclosedClaimRefs?: string[];
    opaqueSignal?: string | null;
    reasoning?: string | null;
    strategicIntent?: string | null;
    confidence?: number | null;
    escalationRequested?: boolean | null;
    settlementReadiness?: string | null;
  }): Promise<NegotiationRoundRecord> {
    const { data, error } = await this.client
      .from("negotiation_rounds")
      .insert({
        session_id: input.sessionId,
        round_number: input.roundNumber,
        actor_did: input.actorDid,
        actor_side: input.actorSide,
        move_type: input.moveType,
        proposal_ciphertext: input.proposalCiphertext ?? null,
        disclosed_claim_refs: input.disclosedClaimRefs ?? [],
        opaque_signal: input.opaqueSignal ?? null,
        reasoning: input.reasoning ?? null,
        strategic_intent: input.strategicIntent ?? null,
        confidence: input.confidence ?? null,
        escalation_requested: input.escalationRequested ?? null,
        settlement_readiness: input.settlementReadiness ?? null,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return data;
  }

  public async appendDisclosure(input: {
    sessionId: string;
    fromDid: string;
    fromSide: "buy" | "sell";
    claimType: string;
    claimAssertionCiphertext: string;
    verified: boolean;
    t3AttestationRef: string;
  }): Promise<NegotiationDisclosureRecord> {
    const { data, error } = await this.client
      .from("negotiation_disclosures")
      .insert({
        session_id: input.sessionId,
        from_did: input.fromDid,
        from_side: input.fromSide,
        claim_type: input.claimType,
        claim_assertion_ciphertext: input.claimAssertionCiphertext,
        verified: input.verified,
        t3_attestation_ref: input.t3AttestationRef,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return data;
  }

  public async listSessions(
    institutionId: string,
    agentDid?: string,
  ): Promise<RedactedNegotiationSessionView[]> {
    let buyQuery = this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("buy_institution_id", institutionId);
    if (agentDid) {
      buyQuery = buyQuery.eq("buy_agent_did", agentDid);
    }
    let sellQuery = this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("sell_institution_id", institutionId);
    if (agentDid) {
      sellQuery = sellQuery.eq("sell_agent_did", agentDid);
    }

    const [buyResult, sellResult] = await Promise.all([
      buyQuery.order("created_at", { ascending: false }),
      sellQuery.order("created_at", { ascending: false }),
    ]);

    if (buyResult.error && sellResult.error) {
      throw new PublicError("service_unavailable", 503, buyResult.error);
    }

    const seen = new Set<string>();
    const sessions: NegotiationSessionRecord[] = [];
    for (const session of [
      ...(buyResult.data ?? []),
      ...(sellResult.data ?? []),
    ]) {
      if (seen.has(session.id)) {
        continue;
      }
      seen.add(session.id);
      if (
        agentDid &&
        session.buy_agent_did !== agentDid &&
        session.sell_agent_did !== agentDid
      ) {
        continue;
      }
      sessions.push(session);
    }

    if (sessions.length === 0) {
      return [];
    }

    const sessionIds = sessions.map((session) => session.id);
    const viewsById = await this.loadSessionViews(sessionIds, institutionId);
    const results: RedactedNegotiationSessionView[] = [];
    for (const session of sessions) {
      const view = viewsById.get(session.id);
      if (view) {
        results.push(view);
      }
    }
    return results;
  }

  public async getSession(
    sessionId: string,
    institutionId: string,
  ): Promise<RedactedNegotiationSessionView | null> {
    const { data: session, error } = await this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (error || !session) {
      return null;
    }

    const isParticipant =
      session.buy_institution_id === institutionId ||
      session.sell_institution_id === institutionId;
    if (!isParticipant) {
      return null;
    }

    const viewsById = await this.loadSessionViews([session.id], institutionId);
    return viewsById.get(session.id) ?? null;
  }

  /**
   * Batch-load the per-session derived data (rounds, disclosures,
   * mandates) for a list of session ids in three queries total,
   * regardless of the number of sessions. Returns a map of
   * `sessionId -> RedactedNegotiationSessionView` for the sessions
   * the operator's institution actually participates in.
   *
   * The previous per-session implementation did 4 sequential
   * queries per session (session, rounds, disclosures, two
   * mandates); for an operator with N sessions, that's 4N
   * round-trips. The batched version is constant in the number of
   * sessions (3 queries, plus one batched mandate fetch) so the
   * dashboard's Negotiations tab stops being N+1.
   *
   * `requestingInstitutionId` is the operator's institution: it's
   * used to derive `counterpartSide` per session (the side the
   * operator is NOT on). All sessions passed in here are
   * guaranteed to have `requestingInstitutionId` as either
   * `buy_institution_id` or `sell_institution_id` — the caller
   * (`listSessions` and `getSession`) is responsible for that
   * filter.
   */
  private async loadSessionViews(
    sessionIds: readonly string[],
    requestingInstitutionId: string,
  ): Promise<Map<string, RedactedNegotiationSessionView>> {
    const result = new Map<string, RedactedNegotiationSessionView>();
    if (sessionIds.length === 0) {
      return result;
    }

    const [sessionsResult, roundsResult, disclosuresResult] = await Promise.all([
      this.client
        .from("negotiation_sessions")
        .select("*")
        .in("id", [...sessionIds]),
      this.client
        .from("negotiation_rounds")
        .select("*")
        .in("session_id", [...sessionIds])
        .order("round_number", { ascending: true }),
      this.client
        .from("negotiation_disclosures")
        .select("*")
        .in("session_id", [...sessionIds])
        .order("created_at", { ascending: true }),
    ]);

    if (sessionsResult.error || !sessionsResult.data) {
      throw new PublicError("service_unavailable", 503, sessionsResult.error);
    }

    const sessions = sessionsResult.data;
    const mandateIdSet = new Set<string>();
    for (const session of sessions) {
      mandateIdSet.add(session.buy_mandate_id);
      mandateIdSet.add(session.sell_mandate_id);
    }
    const mandateIds = Array.from(mandateIdSet);
    const mandatesById = await this.loadMandatesByIds(mandateIds);

    const roundsBySession = new Map<string, NegotiationRoundRecord[]>();
    for (const round of roundsResult.data ?? []) {
      const list = roundsBySession.get(round.session_id) ?? [];
      list.push(round);
      roundsBySession.set(round.session_id, list);
    }
    const disclosuresBySession = new Map<string, NegotiationDisclosureRecord[]>();
    for (const disclosure of disclosuresResult.data ?? []) {
      const list = disclosuresBySession.get(disclosure.session_id) ?? [];
      list.push(disclosure);
      disclosuresBySession.set(disclosure.session_id, list);
    }

    for (const session of sessions) {
      const rounds = roundsBySession.get(session.id) ?? [];
      const disclosures = disclosuresBySession.get(session.id) ?? [];
      const buyMandate = mandatesById.get(session.buy_mandate_id) ?? null;
      const sellMandate = mandatesById.get(session.sell_mandate_id) ?? null;
      const counterpartSide: "buy" | "sell" =
        session.buy_institution_id === requestingInstitutionId ? "sell" : "buy";
      result.set(
        session.id,
        buildSessionView(session, rounds, disclosures, buyMandate, sellMandate, counterpartSide),
      );
    }

    return result;
  }

  /**
   * Batch-fetch mandates by id. Mandates are identified by a
   * primary key (`id`) so we can use `in(id, [...])` to collapse
   * the per-session `getMandateById` calls into a single query.
   * The institution-scope filter is dropped here because the
   * mandate's PK is sufficient to disambiguate rows and the
   * caller already knows which mandate belongs to which side
   * from the session record (buy_mandate_id ↔ buy_institution_id,
   * sell_mandate_id ↔ sell_institution_id).
   */
  private async loadMandatesByIds(
    mandateIds: readonly string[],
  ): Promise<Map<string, NegotiationMandate>> {
    const result = new Map<string, NegotiationMandate>();
    if (mandateIds.length === 0) {
      return result;
    }
    const { data, error } = await this.client
      .from("negotiation_mandates")
      .select("*")
      .in("id", [...mandateIds]);
    if (error || !data) {
      return result;
    }
    for (const record of data) {
      result.set(record.id, negotiationMandateFromRecord(record));
    }
    return result;
  }
}

/**
 * Build the redacted, operator-safe view of a negotiation session
 * from the already-loaded rows. Pure function — no I/O — so the
 * batched `loadSessionViews` path doesn't pay the cost of N
 * separate view assemblies.
 *
 * `counterpartSide` is the side the requesting operator is NOT
 * on. The caller (`loadSessionViews`) derives it per session from
 * the session's `buy_institution_id` / `sell_institution_id` pair
 * and the requesting institution.
 */
function buildSessionView(
  session: NegotiationSessionRecord,
  rounds: readonly NegotiationRoundRecord[],
  disclosures: readonly NegotiationDisclosureRecord[],
  buyMandate: NegotiationMandate | null,
  sellMandate: NegotiationMandate | null,
  counterpartSide: "buy" | "sell",
): RedactedNegotiationSessionView {
  const counterpartProposalRecord = [...rounds]
    .reverse()
    .find(
      (round) =>
        round.actor_side === counterpartSide &&
        (round.move_type === "propose" ||
          round.move_type === "counter" ||
          round.move_type === "accept" ||
          round.move_type === "request_disclosure" ||
          round.move_type === "reveal" ||
          round.move_type === "hold"),
    ) ?? null;
  const counterpartStandingProposal = parseProposalCiphertext(
    counterpartProposalRecord?.proposal_ciphertext ?? null,
  );
  const distanceSignalRecord = [...rounds]
    .reverse()
    .find((round) => round.opaque_signal !== null) ?? null;

  const verifiedDisclosures = disclosures.filter((d) => d.verified);
  const receivedVerifiedClaims = verifiedDisclosures.map((d) => d.claim_type);

  // Mandate-sourced required claims: union of both sides' authored
  // `counterpartyRequirements.requiredClaims`. The round-derived
  // `request_disclosure` set is now a secondary, informational-only
  // signal that the UI can surface if it wants.
  const authorRequired = new Set<string>();
  if (buyMandate) {
    for (const claim of authoredRequiredClaimsFor(buyMandate)) {
      authorRequired.add(claim);
    }
  }
  if (sellMandate) {
    for (const claim of authoredRequiredClaimsFor(sellMandate)) {
      authorRequired.add(claim);
    }
  }
  const requiredClaims = Array.from(authorRequired);

  const askedRequired = Array.from(
    new Set(
      rounds
        .filter((round) => round.move_type === "request_disclosure")
        .flatMap((round) => round.disclosed_claim_refs ?? []),
    ),
  );
  const pendingRequiredClaims = requiredClaims.filter(
    (claim) => !receivedVerifiedClaims.includes(claim),
  );
  const trustLevel: RedactedNegotiationSessionView["trustLevel"] =
    requiredClaims.length === 0
      ? "established"
      : pendingRequiredClaims.length === 0
        ? "established"
        : receivedVerifiedClaims.length === 0
          ? "none"
          : "partial";

  const escalationStatus = session.escalation_status;
  const escalationPending = escalationStatus === "pending";
  const escalationReason = pendingEscalationReason(rounds);

  const latestStrategyRound = [...rounds]
    .reverse()
    .find((round) => round.strategic_intent !== null) ?? null;

  return {
    id: session.id,
    assetCode: session.asset_code,
    status: session.status,
    currentTurn: session.current_turn,
    roundNumber: session.round_number,
    maxRounds: session.max_rounds,
    deadline: session.deadline,
    tradeRef: session.trade_ref,
    counterpartStandingProposal,
    distanceSignal:
      distanceSignalRecord?.opaque_signal === "crossed" ||
      distanceSignalRecord?.opaque_signal === "near" ||
      distanceSignalRecord?.opaque_signal === "moderate" ||
      distanceSignalRecord?.opaque_signal === "far"
        ? distanceSignalRecord.opaque_signal
        : null,
    trustLevel,
    disclosureProgress: {
      requiredClaims,
      receivedVerifiedClaims,
      pendingRequiredClaims,
    },
    escalationStatus,
    escalationPending,
    escalationReason,
    latestStrategySignal: latestStrategyRound?.strategic_intent ?? null,
    disclosedClaims: disclosures.map(toDisclosureView),
    rounds: rounds.map(toRoundView),
    // Surface the round-derived required set as a non-breaking
    // informational field for the UI. The authoritative source is
    // `requiredClaims` above.
    ...({ askedRequiredClaims: askedRequired } as Record<string, unknown>),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  } as RedactedNegotiationSessionView;
}

function authoredRequiredClaimsFor(
  mandate: NegotiationMandate,
): string[] {
  if (
    mandate.counterpartyRequirements &&
    Array.isArray((mandate.counterpartyRequirements as Record<string, unknown>).requiredClaims)
  ) {
    return (mandate.counterpartyRequirements as { requiredClaims: string[] }).requiredClaims;
  }
  return Object.keys(mandate.requiredCounterpartyClaims);
}

function pendingEscalationReason(rounds: readonly NegotiationRoundRecord[]): string | null {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const round = rounds[i];
    if (!round) continue;
    if (round.escalation_requested === true) {
      return round.reasoning ?? round.strategic_intent ?? null;
    }
  }
  return null;
}
