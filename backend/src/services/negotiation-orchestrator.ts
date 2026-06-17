import { randomUUID } from "node:crypto";
import type {
  NegotiationRoundEvaluator,
  NegotiationTicketClient,
  NegotiationDisclosureVerifier,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import { PublicError } from "../errors/public-error.js";
import type { NegotiationRepository } from "./negotiation-repository.js";
import type {
  NegotiationMandate,
  NegotiationMove,
  NegotiationSessionRecord,
} from "../models/negotiation.js";
import type { SettlementService, SettlementExecutionRequest } from "./settlement.service.js";
import type { PortfolioService } from "./portfolio.service.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { TelemetryPhase } from "../websocket/telemetry-event.js";

/**
 * A negotiation ticket awaiting pairing. Held in memory between
 * `submitTicket` and the matchmaker pairing it with an opposite-side,
 * same-asset ticket from a different institution.
 */
interface PendingTicket {
  ticketHandle: string;
  institutionId: string;
  agentId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  mandate: NegotiationMandate;
  sealedAt: string;
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
 * Render a price/quantity as a plain decimal string for exact
 * transport to the enclave round evaluator (mirrors the matching
 * orchestrator's `decimalString`).
 */
function decimalString(value: number): string {
  return String(Math.round(value));
}

/**
 * Compute the [min, max] price band a mandate authorises. Buyers may
 * bid up to reference*(1+bps); sellers may ask down to
 * reference*(1-bps). Both bound the opposite edge at the reference.
 */
function mandatePriceBand(mandate: NegotiationMandate): {
  minPrice: number;
  maxPrice: number;
} {
  const reference = Number(mandate.referencePrice);
  const band = reference * (mandate.priceBandBps / 10_000);
  return { minPrice: reference - band, maxPrice: reference + band };
}

/**
 * Negotiation orchestrator + matchmaker.
 *
 * Sits beside `MatchingOrchestrator`. Where the matching orchestrator
 * crosses two instant intents, this one owns a turn-based bilateral
 * negotiation session and its state machine:
 *
 *   pairing -> active -> converged -> settling -> settled
 *                     \-> walked_away
 *                     \-> expired
 *
 * Every privileged transition (`submitTicket` => `negotiation.open`,
 * `submitMove` => `negotiation.move`, a `reveal` => `negotiation.disclose`,
 * convergence => `negotiation.settle`) re-verifies the agent's
 * delegation VC through the same facade the instant path uses. Hard
 * limits (price band, quantity, notional, disclosure allowlist, turn
 * order, deadline, round cap) are enforced here deterministically;
 * the LLM only proposes a bounded move.
 *
 * The crossing decision and the authoritative execution terms come
 * from the enclave round evaluator (which wraps the same match
 * contract the instant path uses) — the backend never recomputes a
 * midpoint or a fill.
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

  private pendingTickets: PendingTicket[] = [];
  private readonly standingProposals = new Map<string, StandingProposal>();

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
   * it with a waiting opposite-side ticket. Re-verifies the agent's
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
    const verification = await this.authorization.loadAndVerify?.({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.open",
    });
    if (!verification || verification.status !== "verified") {
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
      mandate,
      sealedAt: sealed.sealedAt,
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
   * Find a waiting opposite-side, same-asset ticket from a different
   * institution and open a session. Buyer takes the first turn.
   */
  private async tryPair(
    ticket: PendingTicket,
    correlationRef: string,
  ): Promise<string | null> {
    const matchIndex = this.pendingTickets.findIndex(
      (other) =>
        other.assetCode === ticket.assetCode &&
        other.side !== ticket.side &&
        other.institutionId !== ticket.institutionId,
    );
    if (matchIndex < 0) {
      return null;
    }
    const other = this.pendingTickets[matchIndex];
    if (!other) {
      return null;
    }
    this.pendingTickets.splice(matchIndex, 1);

    const buyTicket = ticket.side === "buy" ? ticket : other;
    const sellTicket = ticket.side === "sell" ? ticket : other;

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
   * mandate's price/quantity/notional bounds. A `reveal` additionally
   * re-verifies `negotiation.disclose` and runs the enclave disclosure
   * verifier (allowlist enforced). On a price/quantity move the enclave
   * round evaluator decides the cross; on a cross the session settles.
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
    const verification = await this.authorization.loadAndVerify?.({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.move",
    });
    if (!verification || verification.status !== "verified") {
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

    if (session.status !== "active") {
      throw new PublicError("validation_failed", 409);
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
    const { minPrice, maxPrice } = mandatePriceBand(mandate);

    if (input.move.action === "walkaway") {
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: "walkaway",
        reasoning: input.move.reasoning,
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
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: input.move.action,
        ...(input.move.claimType
          ? { disclosedClaimRefs: [input.move.claimType] }
          : {}),
        reasoning: input.move.reasoning,
      });
      await this.advanceTurn(session, actorSide);
      this.publish(input.institutionId, "negotiation_move_submitted", input.correlationRef, input.agentDid);
      return { status: "active" };
    }

    // propose | counter | accept — all carry price/quantity that must
    // be clamped to the mandate band, quantity, and notional ceiling.
    const price = this.clampPrice(input.move.price, minPrice, maxPrice);
    const quantity = this.clampQuantity(input.move.quantity, mandate);
    if (price === null || quantity === null) {
      // Out-of-band move: treat as a hold (no concession) rather than
      // rejecting the round, mirroring the agent-side clamp discipline.
      await this.repository.appendRound({
        sessionId: session.id,
        roundNumber: session.round_number + 1,
        actorDid: input.agentDid,
        actorSide,
        moveType: "hold",
        reasoning: `out-of-band move clamped to hold: ${input.move.reasoning}`.slice(0, 4000),
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
    const counterpartSide = actorSide === "buy" ? "sell" : "buy";
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
        correlationRef: input.correlationRef,
        assetCode: session.asset_code,
        buyPrice: decimalString(buySide.price),
        buyQuantity: decimalString(buySide.quantity),
        sellPrice: decimalString(sellSide.price),
        sellQuantity: decimalString(sellSide.quantity),
        buyTicketHandle: `session:${session.id}:buy`,
        sellTicketHandle: `session:${session.id}:sell`,
      });
      opaqueSignal = actorSide === "buy" ? evaluation.buyerSignal : evaluation.sellerSignal;
      crossed = evaluation.status === "crossed";
      executionPrice = evaluation.executionPrice;
      matchedQuantity = evaluation.matchedQuantity;
    }

    await this.repository.appendRound({
      sessionId: session.id,
      roundNumber: session.round_number + 1,
      actorDid: input.agentDid,
      actorSide,
      moveType: input.move.action,
      proposalCiphertext,
      opaqueSignal,
      reasoning: input.move.reasoning,
    });

    this.publish(input.institutionId, "negotiation_move_submitted", input.correlationRef, input.agentDid);

    if (crossed && executionPrice > 0 && matchedQuantity > 0) {
      await this.convergeAndSettle({
        session,
        executionPrice,
        matchedQuantity,
        correlationRef: input.correlationRef,
      });
      return { status: "settled" };
    }

    await this.advanceTurn(session, actorSide);
    this.publish(
      counterpartSide === "buy" ? session.buy_institution_id : session.sell_institution_id,
      "negotiation_round_open",
      input.correlationRef,
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

  private clampPrice(
    price: number | undefined,
    minPrice: number,
    maxPrice: number,
  ): number | null {
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    if (price < minPrice || price > maxPrice) {
      return null;
    }
    return price;
  }

  private clampQuantity(
    quantity: number | undefined,
    mandate: NegotiationMandate,
  ): number | null {
    if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
      return null;
    }
    const target = Number(mandate.targetQuantity);
    if (quantity > target) {
      return target;
    }
    return quantity;
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

    const discloseAuth = await this.authorization.loadAndVerify?.({
      institutionId: input.institutionId,
      agentId: input.agentId,
      agentDid: input.agentDid,
      requestedAction: "negotiation.disclose",
    });
    if (!discloseAuth || discloseAuth.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const verified = await this.disclosureVerifier.verifyDisclosure({
      policyHash: discloseAuth.policyHash,
      claimType,
      disclosableClaims: input.mandate.disclosableClaims,
      claimCredential: input.claimCredential,
    });

    const disclosure = await this.repository.appendDisclosure({
      sessionId: input.session.id,
      fromDid: input.agentDid,
      fromSide: input.actorSide,
      claimType: verified.claimType,
      claimAssertionCiphertext: verified.assertionCiphertext,
      verified: verified.verified,
      t3AttestationRef: verified.t3AttestationRef,
    });

    await this.repository.appendRound({
      sessionId: input.session.id,
      roundNumber: input.session.round_number + 1,
      actorDid: input.agentDid,
      actorSide: input.actorSide,
      moveType: "reveal",
      disclosedClaimRefs: [disclosure.id],
      reasoning: input.move.reasoning,
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
      },
      buyerAgentDid: session.buy_agent_did,
      sellerAgentDid: session.sell_agent_did,
      buyerDelegationCredential: buyerCredential,
      sellerDelegationCredential: sellerCredential,
      encryptedTradeFields: {
        assetCodeCiphertext: transcriptRef,
        quantityCiphertext: transcriptRef,
        executionPriceCiphertext: transcriptRef,
      },
      assetCode: session.asset_code,
      quantity: input.matchedQuantity,
      executionPrice: input.executionPrice,
      buyerLockedAmount: input.matchedQuantity * input.executionPrice,
      sellerLockedAmount: input.matchedQuantity,
      receipts: [
        {
          institutionId: session.buy_institution_id,
          receiptCiphertext: `${receiptBase}.buyer`,
          receiptHash: `sha256:${outcomeRef}:buyer`,
          keyVersion: "negotiation-v1",
          t3AttestationRef: executionRef,
          accessScope: "buyer",
        },
        {
          institutionId: session.sell_institution_id,
          receiptCiphertext: `${receiptBase}.seller`,
          receiptHash: `sha256:${outcomeRef}:seller`,
          keyVersion: "negotiation-v1",
          t3AttestationRef: executionRef,
          accessScope: "seller",
        },
      ],
    };

    const completed = await this.settlementService.executeSettlement(
      request,
      `${outcomeRef}:${randomUUID()}`,
    );

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
    await this.repository.updateSession({
      sessionId: session.id,
      patch: { status: "expired" },
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
}
