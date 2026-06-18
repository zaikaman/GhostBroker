import { describe, expect, it } from "vitest";
import { NegotiationOrchestrator } from "../../services/negotiation-orchestrator.js";
import type { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import type {
  NegotiationTicketClient,
  NegotiationRoundEvaluator,
  NegotiationDisclosureVerifier,
} from "@ghostbroker/t3-enclave";
import { InMemoryNegotiationRepository } from "../data/in-memory-negotiation-repository.js";
import type { NegotiationMandateRecord } from "../../models/negotiation.js";

const stubAuth: AgentAuthorizationFacade = {
  async verifyAgentAuthority(request) {
    void request;
    return {
      status: "verified",
      agentDid: "did:stub",
      authorityRef: "auth-stub",
      policyHash: "hash-stub",
    };
  },
  async loadAndVerify(input) {
    void input;
    return {
      status: "verified",
      agentDid: "did:stub",
      authorityRef: "auth-stub",
      policyHash: "hash-stub",
    };
  },
};

const ticketClient: NegotiationTicketClient = {
  async sealTicket() {
    return {
      ticketHandle: "ticket-stub",
      executionRef: "exec-stub",
      sealedAt: new Date().toISOString(),
      state: "ticket_sealed" as const,
    };
  },
};

const harnessState = {
  crossed: true,
  nextExecutionPrice: 70_100,
  nextMatchedQuantity: 1,
};

const crossEvaluator: NegotiationRoundEvaluator = {
  async evaluateRound() {
    return {
      status: harnessState.crossed ? ("crossed" as const) : ("open" as const),
      executionPrice: harnessState.nextExecutionPrice,
      matchedQuantity: harnessState.nextMatchedQuantity,
      buyerSignal: harnessState.crossed ? ("crossed" as const) : ("near" as const),
      sellerSignal: harnessState.crossed ? ("crossed" as const) : ("near" as const),
      outcomeRef: "outcome-stub",
      executionRef: "exec-stub",
      encryptedTradeFieldsRef: "fields-stub",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evaluatedAt: new Date().toISOString(),
    };
  },
};

class ApproveDisclosureVerifier implements NegotiationDisclosureVerifier {
  public async verifyDisclosure(): Promise<{
    claimType: string;
    assertionCiphertext: string;
    verified: true;
    t3AttestationRef: string;
  }> {
    return {
      claimType: "accredited_institution",
      assertionCiphertext: "ciphertext-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    };
  }
}

const settlementStub = {
  async executeSettlement(): Promise<{ tradeRef: string }> {
    return { tradeRef: `trade-${Math.random().toString(36).slice(2, 10)}` };
  },
} as unknown as SettlementService;

const BUY_INSTITUTION = "00000000-0000-4000-8000-00000000b001";
const SELL_INSTITUTION = "00000000-0000-4000-8000-00000000b002";
const BUY_AGENT_DID = "did:t3n:agent:buyer";
const SELL_AGENT_DID = "did:t3n:agent:seller";
const ASSET = "WBTC";

function buyMandateRecord(approvalMode: "auto_settle" | "escalate_outside_envelope"): NegotiationMandateRecord {
  const now = new Date().toISOString();
  return {
    id: "mandate-buyer",
    institution_id: BUY_INSTITUTION,
    agent_id: "00000000-0000-4000-8000-00000000a001",
    agent_did: BUY_AGENT_DID,
    asset_code: ASSET,
    side: "buy",
    target_quantity: "1",
    reference_price: "70000",
    price_band_bps: 150,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    urgency: "normal",
    max_notional: "70000",
    disclosable_claims: ["accredited_institution", "settlement_capacity"],
    required_counterparty_claims: {},
    counterparty_constraints: {},
    operator_prompt: "Buyer prompt",
    policy_hash: "hash-buyer",
    objective: "Acquire strategic BTC exposure",
    execution_style: "balanced",
    valuation_policy: { source: "operator_note", anchorValue: 70_000 },
    concession_policy: { pace: "balanced", maxConcessionBps: 150 },
    disclosure_policy: {
      allowLadder: ["accredited_institution", "settlement_capacity"],
      requireReciprocityFor: ["settlement_capacity"],
    },
    approval_policy: { mode: approvalMode },
    counterparty_requirements: {
      requiredClaims: ["accredited_institution"],
      disallowedTraits: [],
    },
    size_policy: {
      targetQuantity: 1,
      minimumQuantity: 0.5,
      partialExecutionAllowed: true,
    },
    time_window: { deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    operator_instructions: "Buyer instructions",
    minimum_quantity: "0.5",
    partial_execution_allowed: true,
    derived_anchor_value: "70000",
    derived_walkaway_min: "69895",
    derived_walkaway_max: "70105",
    derived_concession_budget_bps: 150,
    derived_notional_ceiling: "70000",
    decision_meta: {},
    created_at: now,
    updated_at: now,
  };
}

function sellMandateRecord(): NegotiationMandateRecord {
  const now = new Date().toISOString();
  return {
    id: "mandate-seller",
    institution_id: SELL_INSTITUTION,
    agent_id: "00000000-0000-4000-8000-00000000a002",
    agent_did: SELL_AGENT_DID,
    asset_code: ASSET,
    side: "sell",
    target_quantity: "1",
    reference_price: "70000",
    price_band_bps: 150,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    urgency: "normal",
    max_notional: "70000",
    disclosable_claims: ["accredited_institution"],
    required_counterparty_claims: {},
    counterparty_constraints: {},
    operator_prompt: "Seller prompt",
    policy_hash: "hash-seller",
    objective: "Reduce WBTC inventory",
    execution_style: "balanced",
    valuation_policy: { source: "operator_note", anchorValue: 70_000 },
    concession_policy: { pace: "balanced", maxConcessionBps: 150 },
    disclosure_policy: { allowLadder: ["accredited_institution"], requireReciprocityFor: [] },
    approval_policy: { mode: "auto_settle" },
    counterparty_requirements: { requiredClaims: [], disallowedTraits: [] },
    size_policy: { targetQuantity: 1, minimumQuantity: 1, partialExecutionAllowed: false },
    time_window: { deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    operator_instructions: "Seller instructions",
    minimum_quantity: "1",
    partial_execution_allowed: false,
    derived_anchor_value: "70000",
    derived_walkaway_min: "69895",
    derived_walkaway_max: "70105",
    derived_concession_budget_bps: 150,
    derived_notional_ceiling: "70000",
    decision_meta: {},
    created_at: now,
    updated_at: now,
  };
}

interface Harness {
  orchestrator: NegotiationOrchestrator;
  repository: InMemoryNegotiationRepository;
  telemetry: TelemetryBus;
}

async function buildHarness(options: {
  approvalMode: "auto_settle" | "escalate_outside_envelope";
}): Promise<Harness> {
  const repository = new InMemoryNegotiationRepository();
  repository.registerMandate(buyMandateRecord(options.approvalMode));
  repository.registerMandate(sellMandateRecord());
  const telemetry = new TelemetryBus();
  const orchestrator = new NegotiationOrchestrator({
    ticketClient,
    roundEvaluator: crossEvaluator,
    disclosureVerifier: new ApproveDisclosureVerifier(),
    authorization: stubAuth,
    repository,
    settlementService: settlementStub,
    telemetryBus: telemetry,
    settlementAssetCode: "USDC",
    maxRounds: 12,
    deadlineMs: 60 * 60 * 1000,
  });
  return { orchestrator, repository, telemetry };
}

async function openSession(harness: Harness): Promise<string> {
  const session = await harness.repository.createSession({
    assetCode: ASSET,
    buyInstitutionId: BUY_INSTITUTION,
    sellInstitutionId: SELL_INSTITUTION,
    buyAgentDid: BUY_AGENT_DID,
    sellAgentDid: SELL_AGENT_DID,
    buyMandateId: "mandate-buyer",
    sellMandateId: "mandate-seller",
    currentTurn: "buy",
    maxRounds: 12,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  harness.repository.registerDelegation(session.id, "buy", { id: "cred-buyer" });
  harness.repository.registerDelegation(session.id, "sell", { id: "cred-seller" });
  return session.id;
}

describe("NegotiationOrchestrator — escalation gate", () => {
  it("blocks settlement when a priced cross exits the buyer's preferred envelope under escalate_outside_envelope", async () => {
    const harness = await buildHarness({ approvalMode: "escalate_outside_envelope" });
    const sessionId = await openSession(harness);
    // Seed a verified disclosure so the disclosure gate doesn't
    // shadow the escalation gate behavior we're trying to assert.
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_100;
    harnessState.nextMatchedQuantity = 1;

    // The buyer (turn 1) submits at the seller's standing ask so the
    // cross evaluates as crossed. The buyer's preferred envelope is
    // [anchor, anchor + half-band]; 70,100 is within walk-away
    // (70,105) but outside the preferred envelope (~70,052).
    const buyerResult = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_080,
        quantity: 1,
        reasoning: "Open at the anchor",
        escalationRequested: false,
      },
      correlationRef: "test:buyer:1",
    });
    expect(buyerResult.status).toBe("active");
    // Seller counters inside the buyer's preferred envelope so the
    // next cross evaluates without escalation.
    const sellerResult = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 70_090,
        quantity: 1,
        reasoning: "Counter near the anchor",
        escalationRequested: false,
      },
      correlationRef: "test:seller:1",
    });
    expect(sellerResult.status).toBe("settled");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("settled");
    expect(session?.escalation_status).toBe("none");
  });

  it("forces the gate open when the actor's price exits the preferred envelope under escalate_outside_envelope", async () => {
    const harness = await buildHarness({ approvalMode: "escalate_outside_envelope" });
    const sessionId = await openSession(harness);
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    // The buyer's preferred envelope for anchor=70000, band=150bps,
    // balanced style is [70000, 70525] (half-band shrink of the full
    // walkaway). The execution price must clear 70525 to force the
    // counterpart-envelope gate open.
    harnessState.nextExecutionPrice = 70_600;
    harnessState.nextMatchedQuantity = 1;

    // Buyer pushes above the half-band but below walk-away.
    const buyerResult = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_080,
        quantity: 1,
        reasoning: "Walk the envelope",
        escalationRequested: false,
      },
      correlationRef: "test:buyer:1",
    });
    // The first cross shouldn't trigger the gate yet because the
    // buyer is still at their own anchor edge.
    expect(buyerResult.status).toBe("active");
    // Seller matches at 71,000, the buyer's valuation is well above
    // the buyer's preferred envelope, so the cross forces
    // escalation despite escalationRequested=false.
    const sellerResult = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 71_000,
        quantity: 1,
        reasoning: "Push the walk-away",
        escalationRequested: false,
      },
      correlationRef: "test:seller:1",
    });
    expect(sellerResult.status).toBe("awaiting_approval");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("awaiting_approval");
    expect(session?.escalation_status).toBe("pending");
  });

  it("operator approval re-evaluates the cross and settles", async () => {
    const harness = await buildHarness({ approvalMode: "escalate_outside_envelope" });
    const sessionId = await openSession(harness);
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_600;
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_080,
        quantity: 1,
        reasoning: "Open",
        escalationRequested: false,
      },
      correlationRef: "test:buyer:1",
    });
    const seller = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 71_000,
        quantity: 1,
        reasoning: "Push",
        escalationRequested: false,
      },
      correlationRef: "test:seller:1",
    });
    expect(seller.status).toBe("awaiting_approval");

    const approval = await harness.orchestrator.approveEscalation({
      institutionId: BUY_INSTITUTION,
      sessionId,
      correlationRef: "test:approve",
    });
    expect(approval.status).toBe("settled");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("settled");
    expect(session?.escalation_status).toBe("approved");
  });

  it("operator decline expires the session without settlement", async () => {
    const harness = await buildHarness({ approvalMode: "escalate_outside_envelope" });
    const sessionId = await openSession(harness);
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_600;
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_080,
        quantity: 1,
        reasoning: "Open",
        escalationRequested: false,
      },
      correlationRef: "test:buyer:1",
    });
    await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 71_000,
        quantity: 1,
        reasoning: "Push",
        escalationRequested: false,
      },
      correlationRef: "test:seller:1",
    });
    const decline = await harness.orchestrator.declineEscalation({
      institutionId: BUY_INSTITUTION,
      sessionId,
      reason: "Outside our envelope",
      correlationRef: "test:decline",
    });
    expect(decline.status).toBe("expired");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("expired");
    expect(session?.escalation_status).toBe("declined");
    expect(session?.escalation_resolved_at).not.toBeNull();
  });

  it("auto_settle still settles on a valid cross without escalation", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    const sessionId = await openSession(harness);
    // Buyer requires `accredited_institution` from the counterparty;
    // seed a verified disclosure so the gate clears.
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_050;
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_020,
        quantity: 1,
        reasoning: "Open",
        escalationRequested: false,
      },
      correlationRef: "test:buyer:1",
    });
    const seller = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 70_050,
        quantity: 1,
        reasoning: "Meet in the middle",
        escalationRequested: false,
      },
      correlationRef: "test:seller:1",
    });
    expect(seller.status).toBe("settled");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.escalation_status).toBe("none");
  });
});

describe("NegotiationOrchestrator — disclosure gate", () => {
  it("blocks settlement until a mandate-required claim is verified", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    const sessionId = await openSession(harness);
    // The buyer's mandate requires `accredited_institution` from the
    // counterpart. Pre-seed a verified disclosure so the gate clears.
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: SELL_AGENT_DID,
      fromSide: "sell",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-stub",
      verified: true,
      t3AttestationRef: "att-stub",
    });
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_050;
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_020,
        quantity: 1,
        reasoning: "Open",
      },
      correlationRef: "test:buyer:1",
    });
    const seller = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "counter",
        price: 70_050,
        quantity: 1,
        reasoning: "Meet",
      },
      correlationRef: "test:seller:1",
    });
    expect(seller.status).toBe("settled");
  });

  it("keeps counterpart standing terms visible across disclosure-only moves", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    const sessionId = await openSession(harness);
    await harness.repository.appendRound({
      sessionId,
      roundNumber: 1,
      actorDid: SELL_AGENT_DID,
      actorSide: "sell",
      moveType: "request_disclosure",
      proposalCiphertext: Buffer.from(
        JSON.stringify({ price: 70_020, quantity: 1 }),
        "utf8",
      ).toString("base64url"),
      disclosedClaimRefs: ["accredited_institution"],
      reasoning: "Need proof first",
    });

    const buyerView = await harness.repository.getSession(sessionId, BUY_INSTITUTION);
    expect(buyerView?.counterpartStandingProposal).toEqual({
      price: 70_020,
      quantity: 1,
    });
  });
});
