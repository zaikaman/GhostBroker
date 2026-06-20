import { randomUUID } from "node:crypto";
import type {
  NegotiationRoundEvaluator,
  NegotiationTicketClient,
  NegotiationDisclosureVerifier,
} from "../enclave/index.js";
import {
  deriveEncryptedTradeFieldHandles,
  deriveReceiptHash,
  deriveTeeAttestationRef,
} from "../enclave/privacy/encrypted-trade-fields.js";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import { PublicError } from "../errors/public-error.js";
import { logger, redactForbiddenOrderFields } from "../logging/logger.js";
import type { NegotiationRepository } from "./negotiation-repository.js";
import type { AgentRepository } from "./agent-repository.js";
import type {
  NegotiationMandate,
  NegotiationMove,
  NegotiationSessionRecord,
  RedactedNegotiationSessionView,
} from "../models/negotiation.js";
import type { SettlementService, SettlementExecutionRequest } from "./settlement.service.js";
import type { PortfolioService } from "./portfolio.service.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { TelemetryPhase } from "../websocket/telemetry-event.js";
import {
  buildTurnContext,
  derivedPriceBandFor,
  disclosureGateSatisfied,
  normalizeStrategy,
  pairingCompatibility,
  preferredEnvelopeFor,
  priceInsidePreferredEnvelope,
  validateAgentDecision,
  type AgentDecisionMove,
  type AuthoredMandatePolicy,
  type DerivedExecutionRails,
  type NegotiationStrategyProfile,
} from "../negotiation-core/index.js";

/**
 * A negotiation ticket awaiting pairing. Held in memory between
 * `submitTicket` and the matchmaker pairing it with a compatible
 * opposite-side ticket from a different institution.
 *
 * `delegationCredential` is the Ghostbroker W3C VC the facade
 * verified at submit time. The orchestrator snapshots it onto the
 * session via `repository.setSessionDelegation(...)` immediately
 * after `createSession` so a later "Regenerate Delegation" re-mint
 * or a transient DB error in the agent-record lookup cannot change
 * which credential the settlement command builder re-verifies.
 *
 * `compatibilityToken` is the asset/side/institution attestation
 * the agent submitted to `sealTicket`. The TEE binds it into the
 * `ticketHandle` at seal time and re-checks it on `verifyPair`, so
 * storing it here lets the orchestrator replay the exact bytes the
 * TEE originally attested to when it asks the TEE to verify a
 * candidate pair. A mismatch between the stored token and the
 * token the TEE saw at seal time is a hard `incompatible` from
 * `verifyPair`, so we MUST keep these two in lockstep.
 */
interface PendingTicket {
  ticketHandle: string;
  institutionId: string;
  agentId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  compatibilityToken: string;
  mandate: NegotiationMandate;
  profile: NegotiationStrategyProfile | null;
  sealedAt: string;
  delegationCredential: unknown;
}

/**
 * The price/quantity a side most recently put on the table. Held in
 * memory keyed by sessionId+side; the ciphertext persisted on the
 * round row is the durable copy. Reservation thresholds are NEVER
 * stored here — only the standing public proposal.
 */
interface StandingProposal {
  price: number;
  quantity: number;
}

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Render a price or quantity as a plain decimal string for exact
 * transport to the enclave round evaluator. The matching
 * contract (`contracts/matching-policy/src/matching.rs`,
 * v0.4.0+) accepts fractional decimals (`"0.0001"`) and parses
 * them into a scaled `u128` for the cross / midpoint math, so
 * we MUST preserve fractional precision here. `Math.round`
 * would round `0.0001` down to `"0"` and the enclave would
 * return `no_match`. Mirrors the matching orchestrator's
 * `decimalString`.
 */
function decimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`decimalString: non-finite value ${value}`);
  }
  if (value < 0) {
    throw new Error(`decimalString: negative value ${value}`);
  }
  return value.toString();
}

/**
 * Reconstruct a strategy profile from a persisted mandate. If the
 * mandate has no authored columns (legacy), returns null and the
 * orchestrator falls back to the derived numeric rails already stored
 * on the mandate row.
 */
function profileFromMandate(
  mandate: NegotiationMandate,
): NegotiationStrategyProfile | null {
  if (!mandate.objective || !mandate.executionStyle) {
    return null;
  }
  const authored = authoredFromMandate(mandate);
  if (!authored) return null;
  const rails = railsFromMandate(mandate);
  if (!rails) return null;
  return { authored, rails };
}

function authoredFromMandate(
  mandate: NegotiationMandate,
): AuthoredMandatePolicy | null {
  if (!mandate.objective || !mandate.executionStyle || !mandate.valuationPolicy) {
    return null;
  }
  const sizePolicy = (mandate.sizePolicy ?? {}) as Record<string, unknown>;
  const timeWindow = (mandate.timeWindow ?? {}) as Record<string, unknown>;
  const valuationPolicy = mandate.valuationPolicy as Record<string, unknown>;
  const concessionPolicy = (mandate.concessionPolicy ?? {}) as Record<string, unknown>;
  const disclosurePolicy = (mandate.disclosurePolicy ?? {}) as Record<string, unknown>;
  const approvalPolicy = (mandate.approvalPolicy ?? {}) as Record<string, unknown>;
  const counterpartyRequirements = (mandate.counterpartyRequirements ?? {}) as Record<string, unknown>;

  const result: AuthoredMandatePolicy = {
    objective: mandate.objective,
    assetCode: mandate.assetCode,
    side: mandate.side,
    sizePolicy: {
      targetQuantity: Number(sizePolicy.targetQuantity ?? mandate.targetQuantity),
      minimumQuantity: Number(sizePolicy.minimumQuantity ?? mandate.minimumQuantity ?? 0),
      partialExecutionAllowed: Boolean(sizePolicy.partialExecutionAllowed ?? mandate.partialExecutionAllowed ?? true),
    },
    urgency: mandate.urgency,
    executionStyle: mandate.executionStyle,
    valuationPolicy: {
      source: (valuationPolicy.source ?? "operator_note") as AuthoredMandatePolicy["valuationPolicy"]["source"],
      anchorValue: valuationPolicy.anchorValue !== undefined && valuationPolicy.anchorValue !== null
        ? Number(valuationPolicy.anchorValue)
        : Number(mandate.derivedAnchorValue ?? mandate.referencePrice),
    },
    concessionPolicy: {
      pace: (concessionPolicy.pace ?? "balanced") as AuthoredMandatePolicy["concessionPolicy"]["pace"],
      maxConcessionBps: Number(concessionPolicy.maxConcessionBps ?? mandate.derivedConcessionBudgetBps ?? mandate.priceBandBps),
    },
    disclosurePolicy: {
      allowLadder: Array.isArray(disclosurePolicy.allowLadder)
        ? (disclosurePolicy.allowLadder as string[])
        : mandate.disclosableClaims,
    },
    counterpartyRequirements: {
      requiredClaims: Array.isArray(counterpartyRequirements.requiredClaims)
        ? (counterpartyRequirements.requiredClaims as string[])
        : Object.keys(mandate.requiredCounterpartyClaims),
      disallowedTraits: Array.isArray(counterpartyRequirements.disallowedTraits)
        ? (counterpartyRequirements.disallowedTraits as string[])
        : [],
    },
    approvalPolicy: {
      mode: (approvalPolicy.mode ?? "auto_settle") as AuthoredMandatePolicy["approvalPolicy"]["mode"],
    },
    timeWindow: {
      deadline: typeof timeWindow.deadline === "string" ? timeWindow.deadline : mandate.deadline,
    },
    operatorInstructions: mandate.operatorInstructions ?? mandate.operatorPrompt,
  };
  // Conditionally add optional properties to satisfy exactOptionalPropertyTypes.
  if (typeof valuationPolicy.note === "string") {
    result.valuationPolicy.note = valuationPolicy.note;
  }
  if (Array.isArray(disclosurePolicy.requireReciprocityFor)) {
    result.disclosurePolicy.requireReciprocityFor = disclosurePolicy.requireReciprocityFor as string[];
  }
  if (typeof counterpartyRequirements.reputationTier === "string") {
    result.counterpartyRequirements.reputationTier = counterpartyRequirements.reputationTier;
  }
  if (typeof approvalPolicy.preferredEnvelopeNote === "string") {
    result.approvalPolicy.preferredEnvelopeNote = approvalPolicy.preferredEnvelopeNote;
  }
  if (typeof timeWindow.preferredWindowStart === "string") {
    result.timeWindow.preferredWindowStart = timeWindow.preferredWindowStart;
  }
  if (typeof timeWindow.preferredWindowEnd === "string") {
    result.timeWindow.preferredWindowEnd = timeWindow.preferredWindowEnd;
  }
  return result;
}

function railsFromMandate(mandate: NegotiationMandate): DerivedExecutionRails | null {
  if (mandate.derivedAnchorValue !== null && mandate.derivedWalkawayMin !== null) {
    return {
      anchorValue: Number(mandate.derivedAnchorValue),
      priceBandBps: mandate.derivedConcessionBudgetBps ?? mandate.priceBandBps,
      referencePrice: Number(mandate.derivedAnchorValue),
      walkawayMin: Number(mandate.derivedWalkawayMin),
      walkawayMax: Number(mandate.derivedWalkawayMax ?? mandate.derivedAnchorValue),
      concessionBudgetBps: mandate.derivedConcessionBudgetBps ?? mandate.priceBandBps,
      targetQuantity: Number(mandate.targetQuantity),
      minimumQuantity: Number(mandate.minimumQuantity ?? 0),
      partialExecutionAllowed: mandate.partialExecutionAllowed ?? true,
      notionalCeiling: Number(mandate.derivedNotionalCeiling ?? mandate.maxNotional),
    };
  }
  // Legacy mandate: synthesize a best-effort rail set from the stored
  // derived numeric columns so the existing contract path still works.
  const reference = Number(mandate.referencePrice);
  const band = reference * (mandate.priceBandBps / 10_000);
  return {
    anchorValue: reference,
    priceBandBps: mandate.priceBandBps,
    referencePrice: reference,
    walkawayMin: reference - band,
    walkawayMax: reference + band,
    concessionBudgetBps: mandate.priceBandBps,
    targetQuantity: Number(mandate.targetQuantity),
    minimumQuantity: 0,
    partialExecutionAllowed: true,
    notionalCeiling: Number(mandate.maxNotional),
  };
}

/**
 * Negotiation orchestrator + compatibility-aware matchmaker.
 *
 * Owns a turn-based bilateral negotiation session and its state machine:
 *
 *   pairing -> active -> converged -> settling -> settled
 *                     \-> walked_away
 *                     \-> expired
 *
 * Pairing is now compatibility-class based (asset, opposite side,
 * size regime, disclosure/claim compatibility), not just asset/side.
 * Disclosure is a first-class state transition tracked for trust
 * milestones, and convergence requires the disclosure gate to be
 * satisfied in addition to a price cross. The LLM proposes a bounded
 * move including strategic intent/confidence/escalation; the enclave
 * remains the authority for the cross and execution terms.
 */
export class NegotiationOrchestrator {
  private readonly ticketClient: NegotiationTicketClient;
  private readonly roundEvaluator: NegotiationRoundEvaluator;
  private readonly disclosureVerifier: NegotiationDisclosureVerifier;
  private readonly authorization: AgentAuthorizationFacade;
  private readonly repository: NegotiationRepository;
  private readonly settlementService: SettlementService;
  private readonly telemetryBus: TelemetryBus;
  private readonly portfolioService: PortfolioService | undefined;
  private readonly settlementAssetCode: string;
  private readonly maxRounds: number;
  private readonly deadlineMs: number;
  private readonly agentRepository: AgentRepository | undefined;

  private pendingTickets: PendingTicket[] = [];
  private readonly standingProposals = new Map<string, StandingProposal>();
  /**
   * One-shot timers that auto-expire an awaiting_approval session
   * at its deadline. The map is keyed by session id and cleared on
   * approve / decline so the timer never fires after the gate has
   * been resolved. The orchestrator is the only owner.
   */
  private readonly escalationTimers = new Map<string, NodeJS.Timeout>();

  public constructor(input: {
    ticketClient: NegotiationTicketClient;
    roundEvaluator: NegotiationRoundEvaluator;
    disclosureVerifier: NegotiationDisclosureVerifier;
    authorization: AgentAuthorizationFacade;
    repository: NegotiationRepository;
    settlementService: SettlementService;
    telemetryBus: TelemetryBus;
    portfolioService?: PortfolioService;
    settlementAssetCode?: string;
    maxRounds?: number;
    deadlineMs?: number;
    /**
     * Optional agent lookup. Used at settle time to resolve the
     * persisted VC for each side via `loadAndVerify`. Optional
     * because the orchestrator is exercised in tests that don't
     * wire an AgentRepository — when absent, settle falls back
     * to the legacy "snapshotted VC on the session" path (the
     * older `verifyAgentAuthority` direct call is no longer
     * used; tests that exercise settle without an agent repo
     * short-circuit at the `lookupAgent` boundary instead).
     */
    agentRepository?: AgentRepository;
  }) {
    this.ticketClient = input.ticketClient;
    this.roundEvaluator = input.roundEvaluator;
    this.disclosureVerifier = input.disclosureVerifier;
    this.authorization = input.authorization;
    this.repository = input.repository;
    this.settlementService = input.settlementService;
    this.telemetryBus = input.telemetryBus;
    this.portfolioService = input.portfolioService;
    this.settlementAssetCode = input.settlementAssetCode ?? "USDC";
    this.maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.agentRepository = input.agentRepository;
  }

  /**
   * Resolve a side's agent record UUID from its institution + DID.
   * The settlement command builder uses `agentId` to look up the
   * persisted Ghostbroker delegation VC via `loadAndVerify`.
   * Returns `null` when the agent repo isn't wired or the agent
   * record is missing — the caller (settle path) treats that as a
   * fail-closed "expire the session" outcome.
   */
  private async lookupAgent(
    institutionId: string,
    agentDid: string,
  ): Promise<{ id: string; agentDid: string } | null> {
    if (!this.agentRepository) {
      return null;
    }
    try {
      const agent = await this.agentRepository.findByAgentDid(
        institutionId,
        agentDid,
      );
      if (!agent) {
        return null;
      }
      return { id: agent.id, agentDid: agent.agentDid };
    } catch (err) {
      logger.warn(
        {
          err,
          institutionId,
          agentDid,
          event: "negotiation.lookup_agent_failed",
        },
        "Failed to load agent record; session will expire.",
      );
      return null;
    }
  }

  private standingKey(sessionId: string, side: "buy" | "sell"): string {
    return `${sessionId}:${side}`;
  }

  private publish(
    institutionId: string,
    phase: TelemetryPhase,
    correlationRef: string,
    agentId?: string,
  ): void {
    this.telemetryBus.publish({
      institutionId,
      type: "telemetry.processing.changed",
      phase,
      severity: "info",
      correlationRef,
      ...(agentId ? { agentId } : {}),
    });
  }

  /**
   * Seal a negotiation ticket through the enclave and attempt to pair
   * it with a compatible waiting ticket. Re-verifies the agent's
   * delegation VC for `negotiation.open` before sealing. Returns the
   * sealed ticket handle plus the session id if a pairing was made.
   */
  public async submitTicket(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    assetCode: string;
    side: "buy" | "sell";
    compatibilityToken: string;
    correlationRef: string;
  }): Promise<{ ticketHandle: string; sessionId: string | null }> {
    const verification = await this.authorization.loadAndVerify({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.open",
    });
    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const mandate = await this.repository.getMandateByAgent(
      input.institutionId,
      input.agentId,
    );
    if (!mandate) {
      throw new PublicError("validation_failed", 400);
    }
    if (mandate.assetCode !== input.assetCode || mandate.side !== input.side) {
      throw new PublicError("validation_failed", 400);
    }

    const sealed = await this.ticketClient.sealTicket({
      institutionId: input.institutionId,
      agentDid: input.agentDid,
      authorityRef: verification.authorityRef,
      assetCode: input.assetCode,
      side: input.side,
      policyHash: verification.policyHash,
      compatibilityToken: input.compatibilityToken,
      correlationRef: input.correlationRef,
    });

    const ticket: PendingTicket = {
      ticketHandle: sealed.ticketHandle,
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      authorityRef: verification.authorityRef,
      assetCode: input.assetCode,
      side: input.side,
      compatibilityToken: input.compatibilityToken,
      mandate,
      profile: profileFromMandate(mandate),
      sealedAt: sealed.sealedAt,
      delegationCredential: verification.delegationCredential,
    };

    this.publish(
      input.institutionId,
      "negotiation_ticket_sealed",
      input.correlationRef,
      input.agentDid,
    );

    const sessionId = await this.tryPair(ticket, input.correlationRef);
    if (!sessionId) {
      this.pendingTickets.push(ticket);
    }
    return { ticketHandle: sealed.ticketHandle, sessionId };
  }

  /**
   * Find a waiting compatible ticket and open a session. Compatibility
   * is now policy-aware: asset + opposite side + different institution
   * + overlapping size regime + claim compatibility. Falls back to the
   * legacy asset/side/institution check when one side has no authored
   * profile (compatibility codepath). Buyer takes the first turn.
   *
   * Pair authority: the TEE is the structural authority on whether a
   * candidate pair is matchable. The local (asset, side, institution)
   * filter is a pre-screen; once a candidate is found we call the
   * TEE's `verifyPair` and pair ONLY on a `compatible` outcome. A
   * TEE rejection (e.g. malformed compatibility token, swapped
   * asset, same institution) leaves both tickets in the queue and
   * logs a precise `reason_code` so an operator can audit the
   * failure.
   */
  private async tryPair(
    ticket: PendingTicket,
    correlationRef: string,
  ): Promise<string | null> {
    let bestIndex = -1;
    for (let index = 0; index < this.pendingTickets.length; index += 1) {
      const other = this.pendingTickets[index];
      if (!other) continue;
      if (
        other.assetCode !== ticket.assetCode ||
        other.side === ticket.side ||
        other.institutionId === ticket.institutionId
      ) {
        continue;
      }
      // Policy-aware compatibility check when both sides have a profile.
      if (ticket.profile && other.profile) {
        const buyerProfile = ticket.side === "buy" ? ticket.profile : other.profile;
        const sellerProfile = ticket.side === "sell" ? ticket.profile : other.profile;
        const compat = pairingCompatibility(buyerProfile, sellerProfile);
        if (!compat.compatible) {
          continue;
        }
      }
      bestIndex = index;
      break;
    }
    if (bestIndex < 0) {
      return null;
    }
    const other = this.pendingTickets[bestIndex];
    if (!other) {
      return null;
    }

    const buyTicket = ticket.side === "buy" ? ticket : other;
    const sellTicket = ticket.side === "sell" ? ticket : other;

    // TEE pair authority. The orchestrator is the executor of
    // the match queue; the TEE is the authority on whether a
    // candidate pair is structurally matchable. We pass both
    // sides' original ticket handles AND their compatibility
    // tokens (the exact bytes the TEE bound into each handle at
    // seal time). The TEE returns `compatible` only when every
    // structural axis agrees: handle well-formedness, asset
    // agreement, opposite side, different institution.
    //
    // On `incompatible` we keep both tickets in the queue, log
    // the precise reason code, and try the next candidate on
    // the next `submitTicket` call. We do NOT create a session
    // for an `incompatible` pair under any circumstances — this
    // is the load-bearing gate that makes the TEE the matching
    // authority for the pair-up decision.
    const pairVerdict = await this.ticketClient.verifyPair({
      buyTicketHandle: buyTicket.ticketHandle,
      sellTicketHandle: sellTicket.ticketHandle,
      buyCompatibilityToken: buyTicket.compatibilityToken,
      sellCompatibilityToken: sellTicket.compatibilityToken,
      assetCode: ticket.assetCode,
      correlationRef: `pair:${ticket.assetCode}:${correlationRef}`,
    });
    if (pairVerdict.status !== "compatible") {
      logger.error(
        {
          event: "negotiation.pair.rejected_by_tee",
          assetCode: ticket.assetCode,
          buyInstitutionId: buyTicket.institutionId,
          sellInstitutionId: sellTicket.institutionId,
          buyAgentDid: buyTicket.agentDid,
          sellAgentDid: sellTicket.agentDid,
          buyTicketHandle: pairVerdict.buyTicketHandle,
          sellTicketHandle: pairVerdict.sellTicketHandle,
          reason: pairVerdict.reason,
          reasonCode: pairVerdict.reasonCode,
          pairRef: pairVerdict.pairRef,
          executionRef: pairVerdict.executionRef,
        },
        "TEE rejected the candidate pair; both tickets remain pending.",
      );
      return null;
    }

    this.pendingTickets.splice(bestIndex, 1);

    const deadline = new Date(Date.now() + this.deadlineMs).toISOString();
    const session = await this.repository.createSession({
      assetCode: ticket.assetCode,
      buyInstitutionId: buyTicket.institutionId,
      sellInstitutionId: sellTicket.institutionId,
      buyAgentDid: buyTicket.agentDid,
      sellAgentDid: sellTicket.agentDid,
      buyMandateId: buyTicket.mandate.id,
      sellMandateId: sellTicket.mandate.id,
      currentTurn: "buy",
      maxRounds: this.maxRounds,
      deadline,
    });

    // Pin both per-side Ghostbroker delegation W3C VCs onto the
    // session right after the row is created. The settlement
    // command builder re-verifies these VCs verbatim at settlement
    // time, so a later "Regenerate Delegation" re-mint or a
    // transient DB error in the agent-record lookup cannot change
    // which credential is re-verified. The snapshot failures are
    // logged but the session still opens — the settlement path
    // re-reads the snapshot and fails closed on null, which is
    // the same defense in depth the verifier already enforces.
    try {
      await this.repository.setSessionDelegation({
        sessionId: session.id,
        side: "buy",
        delegationCredential: buyTicket.delegationCredential,
      });
    } catch (snapshotError) {
      logger.error(
        {
          event: "negotiation.session.delegation_snapshot_failed",
          sessionId: session.id,
          side: "buy",
          institutionId: buyTicket.institutionId,
          agentDid: buyTicket.agentDid,
          err: redactForbiddenOrderFields(snapshotError),
        },
        "Failed to snapshot buy-side delegation VC; settlement will fail closed.",
      );
    }
    try {
      await this.repository.setSessionDelegation({
        sessionId: session.id,
        side: "sell",
        delegationCredential: sellTicket.delegationCredential,
      });
    } catch (snapshotError) {
      logger.error(
        {
          event: "negotiation.session.delegation_snapshot_failed",
          sessionId: session.id,
          side: "sell",
          institutionId: sellTicket.institutionId,
          agentDid: sellTicket.agentDid,
          err: redactForbiddenOrderFields(snapshotError),
        },
        "Failed to snapshot sell-side delegation VC; settlement will fail closed.",
      );
    }

    this.publish(buyTicket.institutionId, "negotiation_paired", correlationRef, buyTicket.agentDid);
    this.publish(sellTicket.institutionId, "negotiation_paired", correlationRef, sellTicket.agentDid);
    this.publish(buyTicket.institutionId, "negotiation_round_open", correlationRef, buyTicket.agentDid);

    return session.id;
  }

  /**
   * Process one bounded negotiation move on the actor's turn.
   *
   * Enforces, in order: VC re-verification (`negotiation.move`), the
   * session is active, it is the actor's turn, the deadline has not
   * passed, the round cap is not exceeded, and the move is within the
   * mandate's derived price/quantity/notional bounds. A `reveal`
   * additionally re-verifies `negotiation.disclose` and runs the
   * enclave disclosure verifier. On a price/quantity move the enclave
   * round evaluator decides the cross; on a cross that ALSO satisfies
   * the disclosure gate the session settles.
   */
  public async submitMove(input: {
    institutionId: string;
    sessionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    move: NegotiationMove;
    claimCredential?: unknown;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    logger.debug(
      {
        event: "negotiation.move.received",
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentDidPrefix: input.agentDid.slice(0, 30),
        action: input.move.action,
        institutionId: input.institutionId,
      },
      "received negotiation move",
    );
    const verification = await this.authorization.loadAndVerify({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.move",
    });
    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const session = await this.repository.getSessionRecord(input.sessionId);
    if (!session) {
      throw new PublicError("not_found", 404);
    }

    const actorSide = this.resolveActorSide(session, input.agentDid);
    if (!actorSide) {
      throw new PublicError("authorization_failed", 403);
    }
    if (
      session.buy_institution_id !== input.institutionId &&
      session.sell_institution_id !== input.institutionId
    ) {
      throw new PublicError("authorization_failed", 403);
    }

    if (session.status !== "active" && session.status !== "awaiting_approval") {
      throw new PublicError("validation_failed", 409);
    }

    // Session is awaiting operator approval. The agent loop should not
    // be moving here, but defend the gate regardless: a move that
    // arrives while the gate is open is a hold that does not advance
    // the turn. This keeps the API contract honest — escalation is a
    // hard pause, not a hint.
    if (session.status === "awaiting_approval") {
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: "hold",
        reasoning: `awaiting operator approval: ${input.move.reasoning}`.slice(
          0,
          4000,
        ),
        strategicIntent: "hold_for_better_terms",
        confidence: input.move.confidence ?? null,
        escalationRequested: true,
        settlementReadiness: "not_ready",
      });
      await this.repository.updateSession({
        sessionId: session.id,
        patch: { round_number: session.round_number + 1 },
      });
      this.publish(
        input.institutionId,
        "negotiation_escalation_requested",
        input.correlationRef,
        input.agentDid,
      );
      return { status: "awaiting_approval" };
    }

    // Deadline / round-cap enforcement. Either terminal condition
    // expires the session and releases nothing to settle.
    if (Date.parse(session.deadline) <= Date.now()) {
      await this.expireSession(session, input.correlationRef);
      return { status: "expired" };
    }
    if (session.round_number >= session.max_rounds) {
      await this.expireSession(session, input.correlationRef);
      return { status: "expired" };
    }

    // Turn order.
    if (session.current_turn !== actorSide) {
      throw new PublicError("validation_failed", 409);
    }

    const mandate = await this.loadMandateForSide(session, actorSide);
    const rails = railsFromMandate(mandate);
    if (!rails) {
      throw new PublicError("service_unavailable", 503);
    }

    if (input.move.action === "walkaway") {
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: "walkaway",
        reasoning: input.move.reasoning,
        strategicIntent: input.move.strategicIntent ?? "walkaway",
        confidence: input.move.confidence ?? null,
        escalationRequested: input.move.escalationRequested ?? null,
        settlementReadiness: "not_ready",
      });
      await this.repository.updateSession({
        sessionId: session.id,
        patch: { status: "walked_away", round_number: session.round_number + 1 },
      });
      this.releaseSessionLocks(session);
      this.publish(session.buy_institution_id, "negotiation_walked_away", input.correlationRef);
      this.publish(session.sell_institution_id, "negotiation_walked_away", input.correlationRef);
      return { status: "walked_away" };
    }

    if (input.move.action === "reveal") {
      await this.handleDisclosure({
        session,
        actorSide,
        agentDid: input.agentDid,
        institutionId: input.institutionId,
        agentId: input.agentId,
        move: input.move,
        mandate,
        claimCredential: input.claimCredential,
        correlationRef: input.correlationRef,
      });
      // A disclosure restates current terms and passes the turn.
      await this.advanceTurn(session, actorSide);
      return { status: "active" };
    }

    if (input.move.action === "request_disclosure" || input.move.action === "hold") {
      const escalationPhase: TelemetryPhase =
        input.move.escalationRequested === true
          ? "negotiation_escalation_requested"
          : input.move.action === "hold"
            ? "negotiation_held"
            : "negotiation_move_submitted";
      const proposalCiphertext =
        input.move.price !== undefined &&
        Number.isFinite(input.move.price) &&
        input.move.price > 0 &&
        input.move.quantity !== undefined &&
        Number.isFinite(input.move.quantity) &&
        input.move.quantity > 0
          ? Buffer.from(
              JSON.stringify({
                price: input.move.price,
                quantity: input.move.quantity,
              }),
              "utf8",
            ).toString("base64url")
          : null;
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: input.move.action,
        ...(proposalCiphertext ? { proposalCiphertext } : {}),
        ...(input.move.claimType
          ? { disclosedClaimRefs: [input.move.claimType] }
          : {}),
        reasoning: input.move.reasoning,
        strategicIntent: input.move.strategicIntent ?? null,
        confidence: input.move.confidence ?? null,
        escalationRequested: input.move.escalationRequested ?? null,
        settlementReadiness: input.move.settlementReadiness ?? null,
      });
      await this.advanceTurn(session, actorSide);
      this.publish(input.institutionId, escalationPhase, input.correlationRef, input.agentDid);
      return { status: "active" };
    }

    // propose | counter | accept — all carry price/quantity that must
    // be bounded by the shared strategy validator. The backend is the
    // authoritative source; the agent runtime pre-clamps with the
    // SAME validator to avoid burning rounds on rejected moves.
    const authored = authoredFromMandate(mandate);
    // If the mandate predates the authored columns, the legacy numeric
    // rails are authoritative and the shared validator still needs a
    // profile to bound price/quantity. Synthesize one with the rails
    // we already proved above.
    const profile: NegotiationStrategyProfile = authored
      ? normalizeStrategy(authored)
      : buildLegacyProfileFromRails(mandate, rails);
    return this.runPricedMove({
      session,
      actorSide,
      institutionId: input.institutionId,
      mandate,
      profile,
      move: input.move,
      agentId: input.agentId,
      agentDid: input.agentDid,
      claimCredential: input.claimCredential,
      correlationRef: input.correlationRef,
    });
  }

  private async runPricedMove(args: {
    session: NegotiationSessionRecord;
    actorSide: "buy" | "sell";
    institutionId: string;
    mandate: NegotiationMandate;
    profile: NegotiationStrategyProfile;
    move: NegotiationMove;
    agentId: string;
    agentDid: string;
    claimCredential?: unknown;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    const {
      session,
      actorSide,
      institutionId,
      mandate,
      profile,
      move,
      agentId,
      agentDid,
      claimCredential,
      correlationRef,
    } = args;
    const band = derivedPriceBandFor(profile.rails, actorSide);
    const operatorInstructions =
      (mandate.operatorInstructions as string | null | undefined) ??
      (mandate.operatorPrompt as string | null | undefined) ??
      null;
    const liveSessionView = await this.repository.getSession(
      session.id,
      institutionId,
    );
    const standing = await this.repository.getStandingProposals(session.id);
    const counterpartSide = actorSide === "buy" ? "sell" : "buy";
    const counterpartStanding =
      counterpartSide === "buy" ? standing.buy : standing.sell;
    const receivedCounterpartyClaims =
      liveSessionView?.disclosedClaims
        .filter((claim) => claim.verified && claim.fromSide === counterpartSide)
        .map((claim) => claim.claimType) ?? [];
    const priorDisclosureRequests =
      liveSessionView?.rounds
        .filter((round) => round.actorSide === actorSide)
        .filter((round) => round.moveType === "request_disclosure")
        .flatMap((round) => round.disclosedClaimRefs)
        .filter((claim): claim is string => claim.length > 0) ?? [];
    const priorDisclosureReveals =
      liveSessionView?.rounds
        .filter((round) => round.actorSide === actorSide)
        .filter((round) => round.moveType === "reveal")
        .flatMap((round) => round.disclosedClaimRefs)
        .filter((claim): claim is string => claim.length > 0) ?? [];
    const ctx = buildTurnContext({
      profile,
      side: actorSide,
      roundNumber: session.round_number + 1,
      maxRounds: session.max_rounds,
      deadline: session.deadline,
      distanceSignal: liveSessionView?.distanceSignal ?? null,
      counterpartStandingPrice: counterpartStanding?.price ?? null,
      counterpartStandingQuantity: counterpartStanding?.quantity ?? null,
      receivedClaims: receivedCounterpartyClaims,
      concessionConsumedBps: 0,
      ...(priorDisclosureRequests.length > 0
        ? { priorDisclosureRequests }
        : {}),
      ...(priorDisclosureReveals.length > 0
        ? { priorDisclosureReveals }
        : {}),
      ...(operatorInstructions ? { operatorInstructions } : {}),
    });
    const validation = validateAgentDecision(
      {
        action: move.action,
        ...(move.price !== undefined ? { price: move.price } : {}),
        ...(move.quantity !== undefined ? { quantity: move.quantity } : {}),
        ...(move.claimType !== undefined ? { claimType: move.claimType } : {}),
        ...(move.strategicIntent !== undefined
          ? { strategicIntent: move.strategicIntent }
          : {}),
        ...(move.confidence !== undefined
          ? { confidence: move.confidence }
          : {}),
        ...(move.escalationRequested !== undefined
          ? { escalationRequested: move.escalationRequested }
          : {}),
        ...(move.settlementReadiness !== undefined
          ? { settlementReadiness: move.settlementReadiness }
          : {}),
        reasoning: move.reasoning,
      },
      ctx,
    );
    let effectiveMove = validation.accepted;
    if (
      effectiveMove.action === "reveal" &&
      move.action !== "reveal" &&
      claimCredential === undefined
    ) {
      effectiveMove = {
        ...effectiveMove,
        action: "propose",
        strategicIntent: "build_trust",
        settlementReadiness: "not_ready",
        reasoning:
          "Disclosure gate still blocks settlement; restating terms until a verifiable disclosure credential is available.",
      };
    }

    if (effectiveMove.action === "reveal") {
      await this.handleDisclosure({
        session,
        actorSide,
        agentDid,
        institutionId,
        agentId,
        move: effectiveMove,
        mandate,
        claimCredential,
        correlationRef,
      });
      await this.advanceTurn(session, actorSide);
      return { status: "active" };
    }

    if (
      effectiveMove.action === "request_disclosure" ||
      effectiveMove.action === "hold"
    ) {
      const proposalCiphertext =
        effectiveMove.price !== undefined &&
        Number.isFinite(effectiveMove.price) &&
        effectiveMove.price > 0 &&
        effectiveMove.quantity !== undefined &&
        Number.isFinite(effectiveMove.quantity) &&
        effectiveMove.quantity > 0
          ? Buffer.from(
              JSON.stringify({
                price: effectiveMove.price,
                quantity: effectiveMove.quantity,
              }),
              "utf8",
            ).toString("base64url")
          : null;
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: agentDid,
        actorSide,
        moveType: effectiveMove.action,
        ...(proposalCiphertext ? { proposalCiphertext } : {}),
        ...(effectiveMove.claimType
          ? { disclosedClaimRefs: [effectiveMove.claimType] }
          : {}),
        reasoning: effectiveMove.reasoning,
        strategicIntent: effectiveMove.strategicIntent ?? null,
        confidence: effectiveMove.confidence ?? null,
        escalationRequested: effectiveMove.escalationRequested ?? null,
        settlementReadiness: effectiveMove.settlementReadiness ?? null,
      });
      await this.advanceTurn(session, actorSide);
      this.publish(institutionId, "negotiation_move_submitted", correlationRef, agentDid);
      return { status: "active" };
    }

    const bounded = effectiveMove;
    const boundedPrice = bounded.price ?? 0;
    const boundedQuantity = bounded.quantity ?? 0;
    const price =
      boundedPrice > 0 &&
      boundedPrice >= band.minPrice &&
      boundedPrice <= band.maxPrice
        ? boundedPrice
        : null;
    const quantity = boundedQuantity > 0 ? boundedQuantity : null;
    if (price === null || quantity === null) {
      // Out-of-band move: treat as a hold (no concession) rather than
      // rejecting the round, mirroring the agent-side clamp discipline.
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: agentDid,
        actorSide,
        moveType: "hold",
        reasoning: `out-of-band move clamped to hold: ${move.reasoning}`.slice(0, 4000),
        strategicIntent: "hold_for_better_terms",
      });
      await this.advanceTurn(session, actorSide);
      return { status: "active" };
    }

    const proposalCiphertext = Buffer.from(
      JSON.stringify({ price, quantity }),
      "utf8",
    ).toString("base64url");

    this.standingProposals.set(this.standingKey(session.id, actorSide), {
      price,
      quantity,
    });

    // Evaluate the round confidentially against the counterpart's
    // standing proposal (if any). The enclave decides the cross.
    const counterpartyMandate = await this.loadMandateForSide(
      session,
      counterpartSide,
    );
    const counterpart = this.standingProposals.get(
      this.standingKey(session.id, counterpartSide),
    );

    const buySide = actorSide === "buy" ? { price, quantity } : counterpart;
    const sellSide = actorSide === "sell" ? { price, quantity } : counterpart;

    let opaqueSignal: string | null = null;
    let crossed = false;
    let executionPrice = 0;
    let matchedQuantity = 0;

    if (buySide && sellSide) {
      const evaluation = await this.roundEvaluator.evaluateRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        correlationRef,
        assetCode: session.asset_code,
        buyPrice: decimalString(buySide.price),
        buyQuantity: decimalString(buySide.quantity),
        sellPrice: decimalString(sellSide.price),
        sellQuantity: decimalString(sellSide.quantity),
      });
      logger.debug(
        {
          event: "negotiation.round.evaluated",
          sessionId: session.id,
          actorSide,
          status: evaluation.status,
          crossed: evaluation.status === "crossed",
          assetCode: session.asset_code,
        },
        "round evaluator returned a verdict",
      );
      opaqueSignal = actorSide === "buy" ? evaluation.buyerSignal : evaluation.sellerSignal;
      crossed = evaluation.status === "crossed";
      executionPrice = evaluation.executionPrice;
      matchedQuantity = evaluation.matchedQuantity;
    } else {
      logger.debug(
        {
          event: "negotiation.round.evaluate_skipped",
          sessionId: session.id,
          actorSide,
          hasBuySide: buySide !== undefined && buySide !== null,
          hasSellSide: sellSide !== undefined && sellSide !== null,
        },
        "round evaluator not invoked; counterpart proposal absent",
      );
    }

    const counterpartStandingProfile =
      counterpart && counterpartyMandate
        ? profileForCounterpart(counterpartyMandate)
        : null;
    const counterpartStandingApprovalMode =
      (counterpartyMandate?.approvalPolicy as { mode?: string } | null)?.mode ??
      "auto_settle";
    const counterpartStandingEnvelope = counterpartStandingProfile
      ? preferredEnvelopeFor(counterpartStandingProfile, counterpartSide)
      : null;
    const executionPriceAfterEvaluation =
      crossed && executionPrice > 0 ? executionPrice : 0;

    // Server-side escalation enforcement: the priced move and the
    // evaluated cross together form the gate trigger. If the actor's
    // priced proposal exits their preferred envelope under an
    // escalate approval mode, OR the evaluated execution price
    // falls outside the counterpart's preferred envelope under their
    // escalate approval mode, the gate is opened. This makes
    // escalation a real policy guarantee on both sides of the deal.
    const crossesActorEnvelope = !priceInsidePreferredEnvelope(
      profile,
      actorSide,
      price,
    );
    const actorApprovalMode =
      (mandate.approvalPolicy as { mode?: string } | null)?.mode ??
      "auto_settle";
    const actorEscalationRequired =
      actorApprovalMode === "escalate_outside_envelope" &&
      crossesActorEnvelope;
    const counterpartEscalationRequired =
      counterpartStandingApprovalMode === "escalate_outside_envelope" &&
      !!executionPriceAfterEvaluation &&
      counterpartStandingEnvelope !== null &&
      (executionPriceAfterEvaluation < counterpartStandingEnvelope.minPrice ||
        executionPriceAfterEvaluation > counterpartStandingEnvelope.maxPrice);
    const serverEscalationRequired =
      actorEscalationRequired || counterpartEscalationRequired;
    const escalationRequested =
      serverEscalationRequired || bounded.escalationRequested === true;

    const appendedRound = await this.repository.appendRound({
      sessionId: session.id,
      roundNumber: session.round_number + 1,
      actorDid: agentDid,
      actorSide,
      moveType: effectiveMove.action,
      proposalCiphertext,
      opaqueSignal,
      reasoning: effectiveMove.reasoning,
      strategicIntent: effectiveMove.strategicIntent ?? null,
      confidence: effectiveMove.confidence ?? null,
      escalationRequested,
      settlementReadiness: effectiveMove.settlementReadiness ?? null,
    });

    this.publish(institutionId, "negotiation_move_submitted", correlationRef, agentDid);

    // If the priced move exits the actor's preferred envelope under
    // an escalate approval mode, the session pauses for operator
    // approval BEFORE we even look at the cross. Settlement is the
    // thing that has to be authorized; the priced move itself is
    // legitimate and saved on the round row.
    if (escalationRequested && crossed && executionPrice > 0 && matchedQuantity > 0) {
      await this.openEscalationGate({
        session,
        actorSide,
        actorInstitutionId: institutionId,
        initiatingRoundId: appendedRound.id,
        reason:
          effectiveMove.strategicIntent ?? effectiveMove.reasoning ?? null,
        correlationRef,
      });
      return { status: "awaiting_approval" };
    }

    if (crossed && executionPrice > 0 && matchedQuantity > 0) {
      logger.debug(
        {
          event: "negotiation.round.crossed",
          sessionId: session.id,
          actorSide,
        },
        "priced cross detected; running disclosure gate",
      );
      // Disclosure gate: a price cross is not enough if either side
      // still requires a verified claim it has not received.
      const gateOk = await this.disclosureGateSatisfiedFor(session);
      logger.debug(
        {
          event: "negotiation.disclosure_gate.evaluated",
          sessionId: session.id,
          gateSatisfied: gateOk,
        },
        "disclosure gate evaluated",
      );
      if (!gateOk) {
        // Hold the cross pending disclosure; surface a trust-building
        // signal rather than settling.
        this.publish(
          session.buy_institution_id,
          "negotiation_disclosure_required",
          correlationRef,
        );
        this.publish(
          session.sell_institution_id,
          "negotiation_disclosure_required",
          correlationRef,
        );
        await this.advanceTurn(session, actorSide);
        return { status: "active" };
      }
      try {
        await this.convergeAndSettle({
          session,
          executionPrice,
          matchedQuantity,
          correlationRef,
        });
      } catch (err) {
        // convergeAndSettle reset the session to "active" and
        // published settlement_failed telemetry before re-throwing.
        // Return "active" so the agent gets a clean response and
        // can retry on its next tick instead of crashing on a 503.
        logger.warn(
          {
            err,
            sessionId: session.id,
            correlationRef,
            executionPrice,
            matchedQuantity,
            event: "negotiation.converge_and_settle_failed",
          },
          "convergeAndSettle failed; returning active session state to caller.",
        );
        return { status: "active" };
      }
      // `convergeAndSettle` may abort the session (e.g. when
      // the snapshotted delegation VC is missing) and mark it
      // `expired` without throwing. Reflect the durable
      // session state in the response so the agent / test
      // sees the real outcome.
      const settledSession = await this.repository.getSessionRecord(
        session.id,
      );
      return {
        status: settledSession?.status === "expired" ? "expired" : "settled",
      };
    }

    await this.advanceTurn(session, actorSide);
    this.publish(
      counterpartSide === "buy" ? session.buy_institution_id : session.sell_institution_id,
      "negotiation_round_open",
      correlationRef,
    );
    return { status: "active" };
  }

  private resolveActorSide(
    session: NegotiationSessionRecord,
    agentDid: string,
  ): "buy" | "sell" | null {
    if (session.buy_agent_did === agentDid) return "buy";
    if (session.sell_agent_did === agentDid) return "sell";
    return null;
  }

  private async loadMandateForSide(
    session: NegotiationSessionRecord,
    side: "buy" | "sell",
  ): Promise<NegotiationMandate> {
    const institutionId =
      side === "buy" ? session.buy_institution_id : session.sell_institution_id;
    const mandate = await this.repository.getMandateById(
      side === "buy" ? session.buy_mandate_id : session.sell_mandate_id,
      institutionId,
    );
    if (!mandate) {
      throw new PublicError("service_unavailable", 503);
    }
    return mandate;
  }

  private async advanceTurn(
    session: NegotiationSessionRecord,
    actorSide: "buy" | "sell",
  ): Promise<void> {
    await this.repository.updateSession({
      sessionId: session.id,
      patch: {
        current_turn: actorSide === "buy" ? "sell" : "buy",
        round_number: session.round_number + 1,
      },
    });
  }

  private async handleDisclosure(input: {
    session: NegotiationSessionRecord;
    actorSide: "buy" | "sell";
    agentDid: string;
    institutionId: string;
    agentId: string;
    move: NegotiationMove;
    mandate: NegotiationMandate;
    claimCredential: unknown;
    correlationRef: string;
  }): Promise<void> {
    const claimType = input.move.claimType;
    if (!claimType) {
      throw new PublicError("validation_failed", 400);
    }

    const discloseAuth = await this.authorization.loadAndVerify({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.disclose",
    });
    if (discloseAuth.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const verified = await this.disclosureVerifier.verifyDisclosure({
      policyHash: discloseAuth.policyHash,
      claimType,
      disclosableClaims: input.mandate.disclosableClaims,
      claimCredential: input.claimCredential,
    });

    // Persist the disclosure row (assertion ciphertext + attestation
    // ref live there) and then append the round that references it.
    // The round's `disclosedClaimRefs` stores the claim type so the
    // shared validator's "no repeated reveal of the same claim" cap
    // and the agent-side `priorClaimRequests` history can match
    // reveals across rounds.
    await this.repository.appendDisclosure({
      sessionId: input.session.id,
      fromDid: input.agentDid,
      fromSide: input.actorSide,
      claimType: verified.claimType,
      claimAssertionCiphertext: verified.verified
        ? verified.assertionCiphertext
        : "",
      verified: verified.verified,
      t3AttestationRef: verified.t3AttestationRef,
    });

    const proposalCiphertext =
      input.move.price !== undefined &&
      Number.isFinite(input.move.price) &&
      input.move.price > 0 &&
      input.move.quantity !== undefined &&
      Number.isFinite(input.move.quantity) &&
      input.move.quantity > 0
        ? Buffer.from(
            JSON.stringify({
              price: input.move.price,
              quantity: input.move.quantity,
            }),
            "utf8",
          ).toString("base64url")
        : null;

    await this.repository.appendRound({
      sessionId: input.session.id,
      roundNumber: input.session.round_number + 1,
      actorDid: input.agentDid,
      actorSide: input.actorSide,
      moveType: "reveal",
      ...(proposalCiphertext ? { proposalCiphertext } : {}),
      disclosedClaimRefs: [verified.claimType],
      reasoning: input.move.reasoning,
      strategicIntent: input.move.strategicIntent ?? "build_trust",
      confidence: input.move.confidence ?? null,
      escalationRequested: input.move.escalationRequested ?? null,
      settlementReadiness: input.move.settlementReadiness ?? null,
    });

    this.publish(
      input.session.buy_institution_id,
      "negotiation_disclosure_verified",
      input.correlationRef,
    );
    this.publish(
      input.session.sell_institution_id,
      "negotiation_disclosure_verified",
      input.correlationRef,
    );
  }

  /**
   * Disclosure gate: a session may only settle once every required
   * counterparty claim on BOTH mandates has been verified. Reads the
   * authored counterparty requirements when present; otherwise treats
   * the gate as satisfied (legacy compatibility).
   */
  private async disclosureGateSatisfiedFor(
    session: NegotiationSessionRecord,
  ): Promise<boolean> {
    const buyMandate = await this.loadMandateForSide(session, "buy");
    const sellMandate = await this.loadMandateForSide(session, "sell");

    const view = await this.repository.getSession(session.id, session.buy_institution_id);
    if (!view) {
      logger.debug(
        {
          event: "negotiation.disclosure_gate.no_session_view",
          sessionId: session.id,
        },
        "no session view available; legacy gate treated as satisfied",
      );
      return true;
    }
    const buyerReceivedVerifiedClaims = view.disclosedClaims
      .filter((claim) => claim.verified && claim.fromSide === "sell")
      .map((claim) => claim.claimType);
    const sellerReceivedVerifiedClaims = view.disclosedClaims
      .filter((claim) => claim.verified && claim.fromSide === "buy")
      .map((claim) => claim.claimType);

    const buyerRequired = requiredClaimsFor(buyMandate);
    const sellerRequired = requiredClaimsFor(sellMandate);

    logger.debug(
      {
        event: "negotiation.disclosure_gate.check",
        sessionId: session.id,
        buyerRequired,
        buyerReceived: buyerReceivedVerifiedClaims,
        sellerRequired,
        sellerReceived: sellerReceivedVerifiedClaims,
      },
      "disclosure gate membership evaluated",
    );

    // Each side's required claims must have been disclosed AND verified
    // by the counterparty. A side's own disclosures never satisfy its
    // counterparty gate.
    const buyerOk = disclosureGateSatisfied({
      requiredClaims: buyerRequired,
      receivedVerifiedClaims: buyerReceivedVerifiedClaims,
    });
    const sellerOk = disclosureGateSatisfied({
      requiredClaims: sellerRequired,
      receivedVerifiedClaims: sellerReceivedVerifiedClaims,
    });
    return buyerOk && sellerOk;
  }

  private async convergeAndSettle(input: {
    session: NegotiationSessionRecord;
    executionPrice: number;
    matchedQuantity: number;
    correlationRef: string;
  }): Promise<void> {
    const { session } = input;
    await this.repository.updateSession({
      sessionId: session.id,
      patch: { status: "converged", round_number: session.round_number + 1 },
    });
    this.publish(session.buy_institution_id, "negotiation_converged", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_converged", input.correlationRef);

    const buyerCredential = await this.repository.getSessionDelegation(
      session.id,
      "buy",
    );
    const sellerCredential = await this.repository.getSessionDelegation(
      session.id,
      "sell",
    );

    // Resolve each side's agent record UUID from the snapshotted
    // agent DID. The settlement command builder needs `agentId`
    // (not just `agentDid`) to run `loadAndVerify` against the
    // persisted VC. If either side's agent record is missing,
    // refuse to settle — better to fail closed here than to have
    // the settlement service throw `SettlementAuthorityError`
    // without an observable signal. The session transitions to
    // `expired` so the in-memory queue and the durable row
    // agree on the state.
    const buyerAgentRecord = await this.lookupAgent(
      session.buy_institution_id,
      session.buy_agent_did,
    );
    const sellerAgentRecord = await this.lookupAgent(
      session.sell_institution_id,
      session.sell_agent_did,
    );
    if (!buyerAgentRecord || !sellerAgentRecord) {
      logger.error(
        {
          event: "negotiation.settle.missing_session_agent",
          sessionId: session.id,
          hasBuyerAgent: buyerAgentRecord !== null,
          hasSellerAgent: sellerAgentRecord !== null,
          buyInstitutionId: session.buy_institution_id,
          sellInstitutionId: session.sell_institution_id,
        },
        "Session is missing one or both agent records; refusing to settle.",
      );
      await this.repository.updateSession({
        sessionId: session.id,
        patch: { status: "expired" },
      });
      this.publish(
        session.buy_institution_id,
        "negotiation_expired",
        input.correlationRef,
      );
      this.publish(
        session.sell_institution_id,
        "negotiation_expired",
        input.correlationRef,
      );
      return;
    }

    // The buyer/seller snapshotted credentials are still loaded
    // by the orchestrator above for legacy reasons (the VC id
    // may end up in audit_receipts for traceability); the
    // settlement command builder no longer consumes them — it
    // looks the VC up by `(institutionId, agentId)` via
    // `loadAndVerify`. The previous `console.log("[CONVERGE]
    // ... getSessionDelegation")` truncated and emitted the
    // credential IDs to stdout; that is removed here. The
    // structured logger would carry too much sensitive material
    // even at a truncated length, so we do not log the IDs at
    // all. Operators that need to inspect the per-side
    // delegation state should query the `audit_receipts` table
    // after settlement completes.
    void buyerCredential;
    void sellerCredential;

    await this.repository.updateSession({
      sessionId: session.id,
      patch: { status: "settling" },
    });
    this.publish(session.buy_institution_id, "negotiation_settling", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_settling", input.correlationRef);

    const outcomeRef = `negotiation_${session.id}_${randomUUID()}`;
    const executionRef = `t3exec_${randomUUID()}`;
    const receiptBase = `t3receipt.${outcomeRef}.${executionRef}`;
    const transcriptRef = `negotiation-transcript:${session.id}`;

    const request: SettlementExecutionRequest = {
      matchOutcome: {
        outcomeRef,
        executionRef,
        buyerInstitutionId: session.buy_institution_id,
        sellerInstitutionId: session.sell_institution_id,
        encryptedTradeFieldsRef: transcriptRef,
        buyerAuthorityRef: `ghostbroker-delegation:${buyerCredential?.id ?? ""}`,
        sellerAuthorityRef: `ghostbroker-delegation:${sellerCredential?.id ?? ""}`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        status: "matched",
        matchedQuantity: input.matchedQuantity,
        executionPrice: input.executionPrice,
        // Negotiation-orchestrator-driven settlements are
        // gated on the session transcript (the parties agreed
        // to the cross in the open); the per-side lock release
        // amounts are produced by the settlement service from
        // the matched fill and the original mandate's
        // authoritative `quantity`. The orchestrator surfaces
        // the matched quantity / price; the settlement rail
        // computes the per-side release from the mandate so we
        // do not need to carry plaintext `quantity` here.
        buyerLockedAmount: input.matchedQuantity * input.executionPrice,
        sellerLockedAmount: input.matchedQuantity,
      },
      buyerAgentId: buyerAgentRecord.id,
      sellerAgentId: sellerAgentRecord.id,
      buyerAgentDid: session.buy_agent_did,
      sellerAgentDid: session.sell_agent_did,
      // P0 privacy fix: the three settlement columns must NOT
      // share a value (the previous code wrote `transcriptRef`
      // to all three columns, which collapsed asset, quantity,
      // and execution-price correlation into one ref). Each
      // column now carries a distinct SHA-256-based opaque
      // correlation handle derived from the TEE-attested
      // outcome. The handles are deterministic, so the receipt
      // correlation logic that keys on `(outcomeRef,
      // accessScope)` still works unchanged. The handles do not
      // pretend to be ciphertext (they are opaque correlation
      // identifiers, not encrypted field values -- see
      // `enclave/privacy/encrypted-trade-fields.ts`).
      encryptedTradeFields: deriveEncryptedTradeFieldHandles({
        outcomeRef,
        executionRef,
        buyerInstitutionId: session.buy_institution_id,
        sellerInstitutionId: session.sell_institution_id,
      }),
      assetCode: session.asset_code,
      quantity: input.matchedQuantity,
      executionPrice: input.executionPrice,
      buyerLockedAmount: input.matchedQuantity * input.executionPrice,
      sellerLockedAmount: input.matchedQuantity,
      receipts: [
        {
          institutionId: session.buy_institution_id,
          receiptCiphertext: `${receiptBase}.buyer`,
          // P0 privacy fix: real SHA-256 over the receipt
          // ciphertext payload. The previous
          // `sha256:${outcomeRef}:side` value was a
          // deterministic string concatenation that did not
          // authenticate the ciphertext and was trivially
          // forgeable by anyone who knew the outcome ref.
          receiptHash: deriveReceiptHash(`${receiptBase}.buyer`),
          keyVersion: "negotiation-v1",
          // P0 privacy fix: TEE-correlated attestation
          // reference derived from the match outcome + side,
          // not the orchestrator's `executionRef`. The
          // previous value was a locally-minted UUID
          // masquerading as a TEE attestation.
          t3AttestationRef: deriveTeeAttestationRef(outcomeRef, "buyer"),
          accessScope: "buyer",
        },
        {
          institutionId: session.sell_institution_id,
          receiptCiphertext: `${receiptBase}.seller`,
          receiptHash: deriveReceiptHash(`${receiptBase}.seller`),
          keyVersion: "negotiation-v1",
          t3AttestationRef: deriveTeeAttestationRef(outcomeRef, "seller"),
          accessScope: "seller",
        },
      ],
    };

    let completed;
    try {
      completed = await this.settlementService.executeSettlement(
        request,
        `${outcomeRef}:${randomUUID()}`,
      );
    } catch (settleError) {
      // The previous `console.error("[CONVERGE] ... executeSettlement
      // failed")` emitted the full error message and stack to
      // stdout; the stack frame typically includes the settlement
      // request's `matchOutcome` (which carries opaque handles
      // only) and the `encryptedTradeFields` ciphertexts (which
      // are safe). Still, leaving a free-form `console.error`
      // of an exception message in production is a privacy
      // regression risk: a future change to the settlement
      // service might add a `cause` payload that includes a
      // synthetic intent with plaintext trading parameters. The
      // structured logger is the only production-safe channel.
      logger.error(
        {
          event: "negotiation.settlement_failed",
          sessionId: session.id,
          outcomeRef,
          executionRef,
          correlationRef: input.correlationRef,
          // Redact forbidden fields defensively. The settlement
          // service error payload should not contain plaintext
          // trading parameters today, but the redactor is the
          // wire-side guarantee for any future regression.
          error: redactForbiddenOrderFields({
            name: settleError instanceof Error ? settleError.name : "Error",
            message:
              settleError instanceof Error
                ? settleError.message
                : "non-Error thrown from settlementService.executeSettlement",
          }),
        },
        "executeSettlement failed; resetting session to active",
      );
      // Reset the session back to active so the agent loop can retry.
      // Then re-throw so the caller (runPricedMove) can catch the
      // error and return a clean status to the agent instead of
      // propagating the 503 all the way to the Express error handler.
      await this.repository.updateSession({
        sessionId: session.id,
        patch: { status: "active" },
      });
      this.publish(
        session.buy_institution_id,
        "settlement_failed",
        input.correlationRef,
      );
      this.publish(
        session.sell_institution_id,
        "settlement_failed",
        input.correlationRef,
      );
      throw settleError;
    }

    // Note: the previous `console.log("[CONVERGE] ... executeSettlement succeeded")`
    // emitted `session.id` (UUID, opaque) and `completed.tradeRef`
    // (opaque handle) to stdout. The telemetry event
    // `negotiation_settled` (published further down) already
    // carries the same signals; the free-form console log is
    // removed to keep the production log channel structured.

    await this.repository.updateSession({
      sessionId: session.id,
      patch: { status: "settled", trade_ref: completed.tradeRef },
    });
    await this.repository.linkSettledTrade(session.id, completed.tradeRef);

    this.publish(session.buy_institution_id, "negotiation_settled", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_settled", input.correlationRef);
  }

  private async expireSession(
    session: NegotiationSessionRecord,
    correlationRef: string,
  ): Promise<void> {
    this.clearEscalationTimer(session.id);
    await this.repository.updateSession({
      sessionId: session.id,
      patch: { status: "expired", escalation_status: "none" },
    });
    this.releaseSessionLocks(session);
    this.publish(session.buy_institution_id, "negotiation_expired", correlationRef);
    this.publish(session.sell_institution_id, "negotiation_expired", correlationRef);
  }

  /**
   * Best-effort release of any balance locks tied to the session.
   * Negotiation v1 does not pre-lock balances at ticket time (locks
   * are acquired at settlement via the settlement RPC), so this is a
   * no-op hook today; it exists so a future ticket-time reservation
   * has a single release point on every terminal path.
   */
  private releaseSessionLocks(_session: NegotiationSessionRecord): void {
    void _session;
    void this.portfolioService;
    void this.settlementAssetCode;
  }

  // ---------------------------------------------------------------------------
  // Escalation gate — operator-approves-in-UI + auto-expire-on-timeout
  // ---------------------------------------------------------------------------

  /**
   * Open the escalation gate: persist the pending state, surface the
   * telemetry, and arm a deadline timer that auto-expires the session
   * if no operator acts.
   */
  private async openEscalationGate(input: {
    session: NegotiationSessionRecord;
    actorSide: "buy" | "sell";
    actorInstitutionId: string;
    initiatingRoundId: string;
    reason: string | null;
    correlationRef: string;
  }): Promise<void> {
    await this.repository.updateSession({
      sessionId: input.session.id,
      patch: {
        status: "awaiting_approval",
        escalation_status: "pending",
        escalation_initiated_round_id: input.initiatingRoundId,
      },
    });
    this.publish(
      input.session.buy_institution_id,
      "negotiation_escalation_requested",
      input.correlationRef,
    );
    this.publish(
      input.session.sell_institution_id,
      "negotiation_escalation_requested",
      input.correlationRef,
    );
    this.armEscalationTimer(input.session.id, input.session.deadline);
  }

  /**
   * Arm (or re-arm) the deadline timer for an awaiting_approval
   * session. When the deadline passes without an operator decision,
   * the session transitions to expired — never settling outside the
   * envelope.
   */
  private armEscalationTimer(sessionId: string, deadline: string): void {
    this.clearEscalationTimer(sessionId);
    const ms = Math.max(0, Date.parse(deadline) - Date.now());
    const handle = setTimeout(() => {
      void this.expireUnapprovedEscalation(sessionId);
    }, ms);
    this.escalationTimers.set(sessionId, handle);
  }

  private clearEscalationTimer(sessionId: string): void {
    const existing = this.escalationTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.escalationTimers.delete(sessionId);
    }
  }

  private async expireUnapprovedEscalation(sessionId: string): Promise<void> {
    this.escalationTimers.delete(sessionId);
    const session = await this.repository.getSessionRecord(sessionId);
    if (!session) return;
    if (
      session.status !== "awaiting_approval" ||
      session.escalation_status !== "pending"
    ) {
      return;
    }
    await this.repository.updateSession({
      sessionId,
      patch: {
        status: "expired",
        escalation_status: "declined",
        escalation_resolved_at: new Date().toISOString(),
      },
    });
    this.releaseSessionLocks(session);
    const correlationRef = `escalation:expire:${sessionId}:${Date.now()}`;
    this.publish(session.buy_institution_id, "negotiation_escalation_expired", correlationRef);
    this.publish(session.sell_institution_id, "negotiation_escalation_expired", correlationRef);
    this.publish(session.buy_institution_id, "negotiation_expired", correlationRef);
    this.publish(session.sell_institution_id, "negotiation_expired", correlationRef);
  }

  /**
   * Operator approves the escalation. The orchestrator re-evaluates
   * the priced cross against the counterpart's standing proposal,
   * runs the disclosure gate, and — if both clear — settles.
   */
  public async approveEscalation(input: {
    institutionId: string;
    sessionId: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    const session = await this.repository.getSessionRecord(input.sessionId);
    if (!session) throw new PublicError("not_found", 404);
    if (
      session.buy_institution_id !== input.institutionId &&
      session.sell_institution_id !== input.institutionId
    ) {
      throw new PublicError("authorization_failed", 403);
    }
    if (
      session.status !== "awaiting_approval" ||
      session.escalation_status !== "pending"
    ) {
      throw new PublicError("validation_failed", 409);
    }
    if (Date.parse(session.deadline) <= Date.now()) {
      await this.expireUnapprovedEscalation(session.id);
      return { status: "expired" };
    }

    this.clearEscalationTimer(session.id);
    await this.repository.updateSession({
      sessionId: session.id,
      patch: {
        escalation_status: "approved",
        escalation_resolved_at: new Date().toISOString(),
        status: "active",
      },
    });
    this.publish(session.buy_institution_id, "negotiation_escalation_approved", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_escalation_approved", input.correlationRef);

    // Re-evaluate the priced cross against the counterpart's standing
    // proposal. The round row holds the actor's priced proposal; the
    // counterpart's standing proposal is fetched from the round
    // history so we don't depend on this process's in-memory map
    // surviving across the approval pause.
    const standing = await this.repository.getStandingProposals(session.id);
    if (!standing.buy || !standing.sell) {
      // No counterpart proposal on record yet — nothing to settle.
      return { status: "active" };
    }
    const evaluation = await this.roundEvaluator.evaluateRound({
      sessionId: session.id,
      roundNumber: session.round_number,
      correlationRef: input.correlationRef,
      assetCode: session.asset_code,
      buyPrice: decimalString(standing.buy.price),
      buyQuantity: decimalString(standing.buy.quantity),
      sellPrice: decimalString(standing.sell.price),
      sellQuantity: decimalString(standing.sell.quantity),
    });
    if (
      evaluation.status !== "crossed" ||
      evaluation.executionPrice <= 0 ||
      evaluation.matchedQuantity <= 0
    ) {
      return { status: "active" };
    }
    const disclosureOk = await this.disclosureGateSatisfiedFor(session);
    if (!disclosureOk) {
      this.publish(session.buy_institution_id, "negotiation_disclosure_required", input.correlationRef);
      this.publish(session.sell_institution_id, "negotiation_disclosure_required", input.correlationRef);
      return { status: "active" };
    }
    await this.convergeAndSettle({
      session,
      executionPrice: evaluation.executionPrice,
      matchedQuantity: evaluation.matchedQuantity,
      correlationRef: input.correlationRef,
    });
    // `convergeAndSettle` may abort and mark the session
    // `expired` without throwing (e.g. when the snapshotted
    // delegation VC is missing). Reflect the durable state.
    const settledSession = await this.repository.getSessionRecord(session.id);
    return {
      status: settledSession?.status === "expired" ? "expired" : "settled",
    };
  }

  /**
   * Operator declines the escalation. The session expires — no
   * settlement ever happens for the priced move that triggered the
   * gate.
   */
  public async declineEscalation(input: {
    institutionId: string;
    sessionId: string;
    reason?: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    const session = await this.repository.getSessionRecord(input.sessionId);
    if (!session) throw new PublicError("not_found", 404);
    if (
      session.buy_institution_id !== input.institutionId &&
      session.sell_institution_id !== input.institutionId
    ) {
      throw new PublicError("authorization_failed", 403);
    }
    if (
      session.status !== "awaiting_approval" ||
      session.escalation_status !== "pending"
    ) {
      throw new PublicError("validation_failed", 409);
    }
    this.clearEscalationTimer(session.id);
    await this.repository.updateSession({
      sessionId: session.id,
      patch: {
        status: "expired",
        escalation_status: "declined",
        escalation_resolved_at: new Date().toISOString(),
      },
    });
    if (input.reason && input.reason.trim().length > 0) {
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: session.buy_agent_did,
        actorSide: "buy",
        moveType: "hold",
        reasoning: `escalation declined: ${input.reason}`.slice(0, 4000),
        strategicIntent: "hold_for_better_terms",
        settlementReadiness: "not_ready",
      });
    }
    this.releaseSessionLocks(session);
    this.publish(session.buy_institution_id, "negotiation_escalation_declined", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_escalation_declined", input.correlationRef);
    this.publish(session.buy_institution_id, "negotiation_expired", input.correlationRef);
    this.publish(session.sell_institution_id, "negotiation_expired", input.correlationRef);
    return { status: "expired" };
  }
}

function requiredClaimsFor(mandate: NegotiationMandate): string[] {
  if (
    mandate.counterpartyRequirements &&
    Array.isArray((mandate.counterpartyRequirements as Record<string, unknown>).requiredClaims)
  ) {
    return (mandate.counterpartyRequirements as { requiredClaims: string[] }).requiredClaims;
  }
  return Object.keys(mandate.requiredCounterpartyClaims);
}

function profileForCounterpart(
  mandate: NegotiationMandate,
): NegotiationStrategyProfile | null {
  const authored = authoredFromMandate(mandate);
  if (!authored) return null;
  return normalizeStrategy(authored);
}

/**
 * Build a `NegotiationStrategyProfile` from a legacy-numeric mandate
 * whose authored columns are absent. The synthesized authored policy
 * is the legacy-numeric shape the `negotiation-core` normalizer already
 * understands; we pair it with the rails we just derived from the
 * same mandate so the shared validator has a single source of truth
 * for the priced-move bound. Mirrors the synthesized profile the
 * agent runtime uses in `profileFromRuntimeMandate` for compatibility
 * — the rails are byte-identical between the two paths.
 */
function buildLegacyProfileFromRails(
  mandate: NegotiationMandate,
  rails: DerivedExecutionRails,
): NegotiationStrategyProfile {
  const reference = Number(mandate.referencePrice);
  const synthesized: AuthoredMandatePolicy = {
    objective: mandate.objective ?? mandate.operatorPrompt ?? "Negotiate block exposure.",
    assetCode: mandate.assetCode,
    side: mandate.side,
    sizePolicy: {
      targetQuantity: Number(mandate.targetQuantity),
      minimumQuantity: Number(mandate.minimumQuantity ?? 0),
      partialExecutionAllowed: mandate.partialExecutionAllowed ?? true,
    },
    urgency: mandate.urgency,
    executionStyle: "balanced",
    valuationPolicy: {
      source: "operator_note",
      anchorValue: mandate.derivedAnchorValue !== null
        ? Number(mandate.derivedAnchorValue)
        : reference,
    },
    concessionPolicy: {
      pace: "balanced",
      maxConcessionBps:
        mandate.derivedConcessionBudgetBps ?? mandate.priceBandBps ?? 150,
    },
    disclosurePolicy: { allowLadder: mandate.disclosableClaims ?? [] },
    counterpartyRequirements: {
      requiredClaims: Object.keys(mandate.requiredCounterpartyClaims),
      disallowedTraits: [],
    },
    approvalPolicy: { mode: "auto_settle" },
    timeWindow: { deadline: mandate.deadline },
    operatorInstructions: mandate.operatorPrompt,
  };
  return { authored: synthesized, rails };
}

/**
 * Convenience export for callers that want the strategy helpers but
 * only import the orchestrator. Keeps the agent decision type aligned
 * with the validator in `negotiation-strategy.ts`.
 */
export type { AgentDecisionMove };
export type { RedactedNegotiationSessionView };
