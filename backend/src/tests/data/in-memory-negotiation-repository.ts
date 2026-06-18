/**
 * In-memory implementation of {@link NegotiationRepository} for tests.
 *
 * Mirrors the Supabase implementation's behavior without requiring a
 * live database. The escalation-state fields are persisted, so the
 * orchestrator's gate semantics can be exercised end-to-end.
 */

import {
  negotiationMandateFromRecord,
  type NegotiationDisclosureRecord,
  type NegotiationMandate,
  type NegotiationMandateRecord,
  type NegotiationRoundRecord,
  type NegotiationSessionRecord,
  type RedactedNegotiationSessionView,
} from "../../models/negotiation.js";
import type { NegotiationRepository, CreateMandateRepositoryInput } from "../../services/negotiation-repository.js";
import { PublicError } from "../../errors/public-error.js";

type SessionPatch = Partial<
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

function makeId(prefix: string): string {
  // Deterministic UUID-ish id for snapshot-friendly tests.
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export class InMemoryNegotiationRepository implements NegotiationRepository {
  public readonly mandates = new Map<string, NegotiationMandateRecord>();
  public readonly sessions = new Map<string, NegotiationSessionRecord>();
  public readonly rounds: NegotiationRoundRecord[] = [];
  public readonly disclosures: NegotiationDisclosureRecord[] = [];
  public readonly tradeLinks = new Map<string, string>();
  public readonly delegationCredentials = new Map<
    string,
    { id: string } & Record<string, unknown>
  >();

  public createMandate(input: CreateMandateRepositoryInput): Promise<NegotiationMandate> {
    void input;
    return Promise.reject(new Error("not used by these tests"));
  }

  public getMandateByAgent(): Promise<NegotiationMandate | null> {
    return Promise.resolve(null);
  }

  public listMandatesByAgent(): Promise<NegotiationMandate[]> {
    return Promise.resolve([]);
  }

  public getMandateById(
    mandateId: string,
    institutionId: string,
  ): Promise<NegotiationMandate | null> {
    const record = Array.from(this.mandates.values()).find(
      (m) => m.id === mandateId && m.institution_id === institutionId,
    );
    return Promise.resolve(record ? negotiationMandateFromRecord(record) : null);
  }

  public getSessionRecord(sessionId: string): Promise<NegotiationSessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  public getSessionDelegation(
    sessionId: string,
    side: "buy" | "sell",
  ): Promise<({ id: string } & Record<string, unknown>) | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve(null);
    const key = `${sessionId}:${side}`;
    return Promise.resolve(this.delegationCredentials.get(key) ?? null);
  }

  public linkSettledTrade(sessionId: string, tradeRef: string): Promise<void> {
    this.tradeLinks.set(sessionId, tradeRef);
    return Promise.resolve();
  }

  public createSession(input: {
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
    const now = new Date().toISOString();
    const record: NegotiationSessionRecord = {
      id: makeId("session"),
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
      trade_ref: null,
      escalation_status: "none",
      escalation_initiated_round_id: null,
      escalation_resolved_at: null,
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }

  public updateSession(input: {
    sessionId: string;
    patch: SessionPatch;
  }): Promise<NegotiationSessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) {
      return Promise.reject(new PublicError("not_found", 404));
    }
    const next: NegotiationSessionRecord = {
      ...existing,
      ...input.patch,
      updated_at: new Date().toISOString(),
    };
    this.sessions.set(input.sessionId, next);
    return Promise.resolve(next);
  }

  public getStandingProposals(sessionId: string): Promise<{
    buy: { price: number; quantity: number } | null;
    sell: { price: number; quantity: number } | null;
  }> {
    const sessionRounds = this.rounds
      .filter((round) => round.session_id === sessionId)
      .sort((a, b) => a.round_number - b.round_number);
    return Promise.resolve({
      buy: pickStanding(sessionRounds, "buy"),
      sell: pickStanding(sessionRounds, "sell"),
    });
  }

  public appendRound(input: {
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
    const record: NegotiationRoundRecord = {
      id: makeId("round"),
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
      created_at: new Date().toISOString(),
    };
    this.rounds.push(record);
    return Promise.resolve(record);
  }

  public appendDisclosure(input: {
    sessionId: string;
    fromDid: string;
    fromSide: "buy" | "sell";
    claimType: string;
    claimAssertionCiphertext: string;
    verified: boolean;
    t3AttestationRef: string;
  }): Promise<NegotiationDisclosureRecord> {
    const record: NegotiationDisclosureRecord = {
      id: makeId("disclosure"),
      session_id: input.sessionId,
      from_did: input.fromDid,
      from_side: input.fromSide,
      claim_type: input.claimType,
      claim_assertion_ciphertext: input.claimAssertionCiphertext,
      verified: input.verified,
      t3_attestation_ref: input.t3AttestationRef,
      created_at: new Date().toISOString(),
    };
    this.disclosures.push(record);
    return Promise.resolve(record);
  }

  public listSessions(institutionId: string): Promise<RedactedNegotiationSessionView[]> {
    return Promise.resolve(
      Array.from(this.sessions.values())
        .filter(
          (s) =>
            s.buy_institution_id === institutionId ||
            s.sell_institution_id === institutionId,
        )
        .map((s) => this.toView(s.id, institutionId))
        .filter((view): view is RedactedNegotiationSessionView => view !== null),
    );
  }

  public getSession(
    sessionId: string,
    institutionId: string,
  ): Promise<RedactedNegotiationSessionView | null> {
    return Promise.resolve(this.toView(sessionId, institutionId));
  }

  public registerMandate(record: NegotiationMandateRecord): void {
    this.mandates.set(record.id, record);
  }

  public registerDelegation(
    sessionId: string,
    side: "buy" | "sell",
    credential: { id: string } & Record<string, unknown>,
  ): void {
    this.delegationCredentials.set(`${sessionId}:${side}`, credential);
  }

  private toView(
    sessionId: string,
    institutionId: string,
  ): RedactedNegotiationSessionView | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (
      session.buy_institution_id !== institutionId &&
      session.sell_institution_id !== institutionId
    ) {
      return null;
    }
    const sessionRounds = this.rounds
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => a.round_number - b.round_number);
    const sessionDisclosures = this.disclosures
      .filter((d) => d.session_id === sessionId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const buyMandate = this.mandates.get(session.buy_mandate_id) ?? null;
    const sellMandate = this.mandates.get(session.sell_mandate_id) ?? null;
    const verified = sessionDisclosures.filter((d) => d.verified);
    const receivedClaims = verified.map((d) => d.claim_type);
    const authorRequired = new Set<string>();
    for (const m of [buyMandate, sellMandate]) {
      if (!m) continue;
      const raw = m.counterparty_requirements as
        | { requiredClaims?: string[] }
        | null;
      if (raw && Array.isArray(raw.requiredClaims)) {
        for (const claim of raw.requiredClaims) authorRequired.add(claim);
      }
    }
    const requiredClaims = Array.from(authorRequired);
    const pending = requiredClaims.filter((c) => !receivedClaims.includes(c));
    const trustLevel: RedactedNegotiationSessionView["trustLevel"] =
      requiredClaims.length === 0
        ? "established"
        : pending.length === 0
          ? "established"
          : receivedClaims.length === 0
            ? "none"
            : "partial";
    const counterpartSide =
      session.buy_institution_id === institutionId ? "sell" : "buy";
    const counterpartProposal = [...sessionRounds]
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
      );
    return {
      id: session.id,
      assetCode: session.asset_code,
      status: session.status,
      currentTurn: session.current_turn,
      roundNumber: session.round_number,
      maxRounds: session.max_rounds,
      deadline: session.deadline,
      tradeRef: session.trade_ref,
      counterpartStandingProposal: parseProposalCiphertext(
        counterpartProposal?.proposal_ciphertext ?? null,
      ),
      distanceSignal: null,
      trustLevel,
      disclosureProgress: {
        requiredClaims,
        receivedVerifiedClaims: receivedClaims,
        pendingRequiredClaims: pending,
      },
      escalationStatus: session.escalation_status,
      escalationPending: session.escalation_status === "pending",
      escalationReason: pendingEscalationReason(sessionRounds),
      latestStrategySignal: latestStrategy(sessionRounds),
      disclosedClaims: sessionDisclosures.map((d) => ({
        id: d.id,
        fromDid: d.from_did,
        fromSide: d.from_side,
        claimType: d.claim_type,
        verified: d.verified,
        t3AttestationRef: d.t3_attestation_ref,
        createdAt: d.created_at,
      })),
      rounds: sessionRounds.map((r) => ({
        id: r.id,
        roundNumber: r.round_number,
        actorDid: r.actor_did,
        actorSide: r.actor_side,
        moveType: r.move_type,
        disclosedClaimRefs: r.disclosed_claim_refs,
        opaqueSignal:
          r.opaque_signal === "crossed" ||
          r.opaque_signal === "near" ||
          r.opaque_signal === "moderate" ||
          r.opaque_signal === "far"
            ? r.opaque_signal
            : null,
        reasoning: r.reasoning,
        strategicIntent: r.strategic_intent,
        confidence: r.confidence,
        escalationRequested: r.escalation_requested,
        settlementReadiness: r.settlement_readiness,
        createdAt: r.created_at,
      })),
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    };
  }
}

function parseProposalCiphertext(ciphertext: string | null): {
  price: number | null;
  quantity: number | null;
} {
  if (!ciphertext) return { price: null, quantity: null };
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

function pickStanding(
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

function pendingEscalationReason(
  rounds: NegotiationRoundRecord[],
): string | null {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const round = rounds[i];
    if (!round) continue;
    if (round.escalation_requested === true) {
      return round.reasoning ?? round.strategic_intent ?? null;
    }
  }
  return null;
}

function latestStrategy(rounds: NegotiationRoundRecord[]): string | null {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const round = rounds[i];
    if (!round) continue;
    if (round.strategic_intent !== null) return round.strategic_intent;
  }
  return null;
}
