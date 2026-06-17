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

interface QueryChain<TResult> {
  eq(column: string, value: string): QueryChain<TResult>;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): Promise<{ data: TResult[] | null; error: Error | null }>;
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

interface UpdateQuery<TResult> {
  update(value: Record<string, unknown>): {
    eq(column: string, value: string): {
      select(columns?: string): {
        single(): Promise<{ data: TResult | null; error: Error | null }>;
      };
    };
  };
}

interface SupabaseNegotiationClient {
  from(table: "negotiation_mandates"): InsertQuery<NegotiationMandateRecord> &
    SelectQuery<NegotiationMandateRecord> &
    UpdateQuery<NegotiationMandateRecord>;
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

export interface NegotiationRepository {
  createMandate(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    mandate: NegotiationMandateInput;
    policyHash: string;
  }): Promise<NegotiationMandate>;
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
    patch: Partial<Pick<NegotiationSessionRecord, "status" | "current_turn" | "round_number" | "trade_ref" | "deadline">>;
  }): Promise<NegotiationSessionRecord>;
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
  listSessions(institutionId: string): Promise<RedactedNegotiationSessionView[]>;
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

  public async createMandate(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    mandate: NegotiationMandateInput;
    policyHash: string;
  }): Promise<NegotiationMandate> {
    const { data, error } = await this.client
      .from("negotiation_mandates")
      .insert({
        institution_id: input.institutionId,
        agent_id: input.agentId,
        agent_did: input.agentDid,
        asset_code: input.mandate.assetCode,
        side: input.mandate.side,
        target_quantity: input.mandate.targetQuantity,
        reference_price: input.mandate.referencePrice,
        price_band_bps: input.mandate.priceBandBps,
        deadline: input.mandate.deadline,
        urgency: input.mandate.urgency,
        max_notional: input.mandate.maxNotional,
        disclosable_claims: input.mandate.disclosableClaims,
        required_counterparty_claims: input.mandate.requiredCounterpartyClaims,
        counterparty_constraints: input.mandate.counterpartyConstraints,
        operator_prompt: input.mandate.operatorPrompt,
        policy_hash: input.policyHash,
      })
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
    const agentDid =
      side === "buy" ? session.buy_agent_did : session.sell_agent_did;

    const { data, error } = await this.client
      .from("agents")
      .select("metadata")
      .eq("agent_did", agentDid)
      .single();

    if (error || !data || !data.metadata) {
      return null;
    }
    const credential = (data.metadata as Record<string, unknown>)[
      "delegation_credential"
    ];
    if (!credential || typeof credential !== "object") {
      return null;
    }
    const typed = credential as { id?: unknown } & Record<string, unknown>;
    if (typeof typed.id !== "string") {
      return null;
    }
    return typed as { id: string } & Record<string, unknown>;
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
        "status" | "current_turn" | "round_number" | "trade_ref" | "deadline"
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
  ): Promise<RedactedNegotiationSessionView[]> {
    const { data: buyData, error: buyError } = await this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("buy_institution_id", institutionId)
      .order("created_at", { ascending: false });
    const { data: sellData, error: sellError } = await this.client
      .from("negotiation_sessions")
      .select("*")
      .eq("sell_institution_id", institutionId)
      .order("created_at", { ascending: false });

    if (buyError && sellError) {
      throw new PublicError("service_unavailable", 503, buyError);
    }

    const seen = new Set<string>();
    const sessions = [...(buyData ?? []), ...(sellData ?? [])].filter((session) => {
      if (seen.has(session.id)) {
        return false;
      }
      seen.add(session.id);
      return true;
    });

    const results: RedactedNegotiationSessionView[] = [];
    for (const session of sessions) {
      const view = await this.getSession(session.id, institutionId);
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

    const { data: rounds } = await this.client
      .from("negotiation_rounds")
      .select("*")
      .eq("session_id", sessionId)
      .order("round_number", { ascending: true });
    const { data: disclosures } = await this.client
      .from("negotiation_disclosures")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    const counterpartSide =
      session.buy_institution_id === institutionId ? "sell" : "buy";
    const counterpartProposalRecord = [...(rounds ?? [])]
      .reverse()
      .find((round) =>
        round.actor_side === counterpartSide &&
        (round.move_type === "propose" ||
          round.move_type === "counter" ||
          round.move_type === "accept")
      ) ?? null;
    const counterpartStandingProposal = parseProposalCiphertext(
      counterpartProposalRecord?.proposal_ciphertext ?? null,
    );
    const distanceSignalRecord = [...(rounds ?? [])]
      .reverse()
      .find((round) => round.opaque_signal !== null) ?? null;

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
      disclosedClaims: (disclosures ?? []).map(toDisclosureView),
      rounds: (rounds ?? []).map(toRoundView),
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    };
  }
}
