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

/**
 * End-to-end orchestrator coverage for the hackathon demo's
 * hosted path.
 *
 * Pre-repositioning, the hackathon demo's hosted agents would
 * negotiate `settlement_capacity` round-by-round alongside
 * `accredited_institution`. That path is now reserved for
 * non-demo experimentation: `settlement_capacity` is a
 * pre-launch readiness fact (verified by the backend's
 * `assertSettlementReady()` check before the hosted process
 * ever starts), and the only claim the demo runtime exchanges
 * is `accredited_institution`.
 *
 * These tests pin the demo's settlement shape so the regression
 * that brought back the reciprocal multi-claim gate in the
 * hosted path would fail loudly here.
 */

const stubAuth: AgentAuthorizationFacade = {
  async verifyAgentAuthority(request) {
    void request;
    return {
      status: "verified",
      agentDid: "did:stub",
      authorityRef: "auth-stub",
      policyHash: "hash-stub",
      delegationCredential: { id: "vc-stub" },
    };
  },
  async loadAndVerify(input) {
    void input;
    return {
      status: "verified",
      agentDid: "did:stub",
      authorityRef: "auth-stub",
      policyHash: "hash-stub",
      delegationCredential: { id: "vc-stub" },
    };
  },
};

const ticketClient: NegotiationTicketClient = {
  async sealTicket() {
    return {
      ticketHandle: "ticket-demo",
      executionRef: "exec-demo",
      sealedAt: new Date().toISOString(),
      state: "ticket_sealed" as const,
    };
  },
};

const harnessState = {
  crossed: true,
  nextExecutionPrice: 70_050,
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
      outcomeRef: "outcome-demo",
      executionRef: "exec-demo",
      encryptedTradeFieldsRef: "fields-demo",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evaluatedAt: new Date().toISOString(),
    };
  },
};

class ApproveDisclosureVerifier implements NegotiationDisclosureVerifier {
  public async verifyDisclosure(
    request: Parameters<NegotiationDisclosureVerifier["verifyDisclosure"]>[0],
  ): Promise<{
    claimType: string;
    assertionCiphertext: string;
    verified: true;
    t3AttestationRef: string;
  }> {
    return {
      claimType: request.claimType,
      assertionCiphertext: `ciphertext-${request.claimType}`,
      verified: true,
      t3AttestationRef: `att-${request.claimType}`,
    };
  }
}

const settlementStub = {
  async executeSettlement(): Promise<{ tradeRef: string }> {
    return { tradeRef: `trade-demo-${Math.random().toString(36).slice(2, 10)}` };
  },
} as unknown as SettlementService;

const BUY_INSTITUTION = "00000000-0000-4000-8000-00000000d001";
const SELL_INSTITUTION = "00000000-0000-4000-8000-00000000d002";
const BUY_AGENT_DID = "did:t3n:agent:hosted-demo-buyer";
const SELL_AGENT_DID = "did:t3n:agent:hosted-demo-seller";
const ASSET = "WBTC";

/**
 * Build the demo's per-side mandate: each side only requires the
 * `accredited_institution` claim from the counterpart. The
 * `settlement_capacity` claim that the old reciprocal path asked
 * for is intentionally absent here.
 */
function demoMandateRecord(
  side: "buy" | "sell",
  institutionId: string,
  agentId: string,
  agentDid: string,
): NegotiationMandateRecord {
  const now = new Date().toISOString();
  return {
    id: `mandate-demo-${side}`,
    institution_id: institutionId,
    agent_id: agentId,
    agent_did: agentDid,
    asset_code: ASSET,
    side,
    target_quantity: "1",
    reference_price: "70000",
    price_band_bps: 150,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    urgency: "normal",
    max_notional: "70000",
    // Demo disclosure ladder: only `accredited_institution` is
    // ever exchanged. `settlement_capacity` is pre-cleared by
    // the backend's `assertSettlementReady()` before launch.
    disclosable_claims: ["accredited_institution"],
    required_counterparty_claims: {},
    counterparty_constraints: {},
    operator_prompt: `${side} demo prompt`,
    policy_hash: `hash-demo-${side}`,
    objective: `Demo ${side} mandate`,
    execution_style: "balanced",
    valuation_policy: { source: "operator_note", anchorValue: 70_000 },
    concession_policy: { pace: "balanced", maxConcessionBps: 150 },
    disclosure_policy: {
      allowLadder: ["accredited_institution"],
      requireReciprocityFor: [],
    },
    approval_policy: { mode: "auto_settle" },
    counterparty_requirements: {
      requiredClaims: ["accredited_institution"],
      disallowedTraits: [],
    },
    size_policy: {
      targetQuantity: 1,
      minimumQuantity: 1,
      partialExecutionAllowed: false,
    },
    time_window: { deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    operator_instructions: "Demo instructions",
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

interface DemoHarness {
  orchestrator: NegotiationOrchestrator;
  repository: InMemoryNegotiationRepository;
  telemetry: TelemetryBus;
  ticketClient: NegotiationTicketClient;
}

async function buildDemoHarness(): Promise<DemoHarness> {
  const repository = new InMemoryNegotiationRepository();
  repository.registerMandate(
    demoMandateRecord(
      "buy",
      BUY_INSTITUTION,
      "00000000-0000-4000-8000-00000000d101",
      BUY_AGENT_DID,
    ),
  );
  repository.registerMandate(
    demoMandateRecord(
      "sell",
      SELL_INSTITUTION,
      "00000000-0000-4000-8000-00000000d102",
      SELL_AGENT_DID,
    ),
  );
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
  return { orchestrator, repository, telemetry, ticketClient };
}

async function openDemoSession(harness: DemoHarness): Promise<string> {
  const session = await harness.repository.createSession({
    assetCode: ASSET,
    buyInstitutionId: BUY_INSTITUTION,
    sellInstitutionId: SELL_INSTITUTION,
    buyAgentDid: BUY_AGENT_DID,
    sellAgentDid: SELL_AGENT_DID,
    buyMandateId: "mandate-demo-buy",
    sellMandateId: "mandate-demo-sell",
    currentTurn: "buy",
    maxRounds: 12,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  harness.repository.registerDelegation(session.id, "buy", { id: "cred-demo-buyer" });
  harness.repository.registerDelegation(session.id, "sell", { id: "cred-demo-seller" });
  return session.id;
}

describe("NegotiationOrchestrator — hosted demo settlement path", () => {
  it("settles end-to-end when both sides only require accredited_institution", async () => {
    // The demo's hosted mandate only requires the
    // institutional accreditation claim from the counterpart.
    // `settlement_capacity` is pre-cleared by the backend
    // before the hosted process ever starts — the orchestrator
    // never sees it as a per-round negotiated claim.
    const harness = await buildDemoHarness();
    const sessionId = await openDemoSession(harness);
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_000;
    harnessState.nextMatchedQuantity = 1;

    // Tick 1: buyer opens with a priced proposal.
    const buyerOpen = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_000,
        quantity: 1,
        reasoning: "Open at the shared anchor.",
        escalationRequested: false,
      },
      correlationRef: "test:demo:buyer-open",
    });
    expect(buyerOpen.status).toBe("active");

    // Tick 2: seller reveals accredited_institution while
    // restating the same terms (the demo's deterministic
    // "build_trust reveal" move).
    const sellerReveal = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reveal seller accreditation.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: SELL_AGENT_DID },
      correlationRef: "test:demo:seller-reveal",
    });
    expect(sellerReveal.status).toBe("active");

    // Tick 3: buyer reciprocates with its own
    // accredited_institution reveal.
    const buyerReveal = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reveal buyer accreditation.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: BUY_AGENT_DID },
      correlationRef: "test:demo:buyer-reveal",
    });
    expect(buyerReveal.status).toBe("active");

    // Tick 4: seller accepts the crossed terms.
    const sellerAccept = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "accept",
        price: 70_000,
        quantity: 1,
        reasoning: "Reciprocal accreditation verified; accepting crossed terms.",
        escalationRequested: false,
      },
      correlationRef: "test:demo:seller-accept",
    });
    expect(sellerAccept.status).toBe("settled");

    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("settled");
    expect(session?.trade_ref).toMatch(/^trade-demo-/);
    expect(harness.repository.tradeLinks.get(sessionId)).toBe(session?.trade_ref);

    // Only `accredited_institution` shows up in the disclosure
    // log; `settlement_capacity` was pre-cleared at launch and
    // never appears in the per-round disclosure stream.
    expect(
      harness.repository.disclosures
        .filter((disclosure) => disclosure.session_id === sessionId)
        .map((disclosure) => ({
          fromSide: disclosure.from_side,
          claimType: disclosure.claim_type,
          verified: disclosure.verified,
        })),
    ).toEqual([
      { fromSide: "sell", claimType: "accredited_institution", verified: true },
      { fromSide: "buy", claimType: "accredited_institution", verified: true },
    ]);
  });

  it("regression: a settlement_capacity disclosure at runtime does not advance the disclosure gate", async () => {
    // If a future hosted path regresses and tries to negotiate
    // `settlement_capacity` round-by-round, the orchestrator
    // still records the disclosure but the gate is satisfied by
    // `accredited_institution` alone — `settlement_capacity` is
    // not in either side's `requiredClaims` list for the
    // hosted demo. The session settles on the same single
    // institutional accreditation, not on the pre-cleared
    // settlement readiness fact.
    const harness = await buildDemoHarness();
    const sessionId = await openDemoSession(harness);
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_000;

    // Open + reveal + reveal with the demo's only required claim.
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_000,
        quantity: 1,
        reasoning: "Open",
        escalationRequested: false,
      },
      correlationRef: "test:demo:regression:open",
    });
    await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reveal",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: SELL_AGENT_DID },
      correlationRef: "test:demo:regression:seller-reveal",
    });
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reveal",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: BUY_AGENT_DID },
      correlationRef: "test:demo:regression:buyer-reveal",
    });

    // If `settlement_capacity` is appended as an "extra"
    // disclosure at runtime, the orchestrator records it but the
    // settlement still only requires the
    // `accredited_institution` claim to clear the gate. The
    // buyer's last move was a reveal so it is the seller's turn
    // for the next move — let the seller append the redundant
    // settlement_capacity reveal.
    await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "settlement_capacity",
        price: 70_000,
        quantity: 1,
        reasoning: "Redundant runtime settlement_capacity reveal",
        escalationRequested: false,
      },
      claimCredential: { claimType: "settlement_capacity", subject: SELL_AGENT_DID },
      correlationRef: "test:demo:regression:settlement-capacity-reveal",
    });

    // Buyer's turn: restate the priced proposal (the cross is
    // feasible; the orchestrator keeps the session active while
    // both sides continue).
    await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_000,
        quantity: 1,
        reasoning: "Restate",
        escalationRequested: false,
      },
      correlationRef: "test:demo:regression:restate",
    });

    const accept = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "accept",
        price: 70_000,
        quantity: 1,
        reasoning: "Reciprocal accreditation verified; accepting.",
        escalationRequested: false,
      },
      correlationRef: "test:demo:regression:accept",
    });
    expect(accept.status).toBe("settled");

    // The settlement reflects the required claim only. The
    // runtime `settlement_capacity` disclosure is recorded but
    // is not what satisfied the gate — `accredited_institution`
    // was satisfied one round earlier. This is the demo
    // invariant: settlement readiness is a launch fact, not a
    // per-round negotiation.
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("settled");
    const disclosures = harness.repository.disclosures
      .filter((disclosure) => disclosure.session_id === sessionId)
      .map((disclosure) => disclosure.claim_type);
    expect(disclosures).toContain("settlement_capacity");
    expect(disclosures.filter((claim) => claim === "accredited_institution")).toHaveLength(2);
  });

  it("keeps reciprocal settlement_capacity disclosure gate as supported backend behavior (non-demo coverage)", async () => {
    // The reciprocal multi-claim gate stays supported as a
    // backend capability — the demo just doesn't exercise it.
    // This test exercises the legacy path through the public
    // orchestrator API to make sure the regression test for the
    // reciprocal gate still passes deterministically.
    const repository = new InMemoryNegotiationRepository();
    const reciprocalClaims = ["accredited_institution", "settlement_capacity"];
    repository.registerMandate({
      ...demoMandateRecord(
        "buy",
        BUY_INSTITUTION,
        "00000000-0000-4000-8000-00000000d101",
        BUY_AGENT_DID,
      ),
      counterparty_requirements: {
        requiredClaims: reciprocalClaims,
        disallowedTraits: [],
      },
      disclosure_policy: {
        allowLadder: reciprocalClaims,
        requireReciprocityFor: ["settlement_capacity"],
      },
      disclosable_claims: reciprocalClaims,
    });
    repository.registerMandate({
      ...demoMandateRecord(
        "sell",
        SELL_INSTITUTION,
        "00000000-0000-4000-8000-00000000d102",
        SELL_AGENT_DID,
      ),
      counterparty_requirements: {
        requiredClaims: reciprocalClaims,
        disallowedTraits: [],
      },
      disclosure_policy: {
        allowLadder: reciprocalClaims,
        requireReciprocityFor: ["settlement_capacity"],
      },
      disclosable_claims: reciprocalClaims,
    });
    const orchestrator = new NegotiationOrchestrator({
      ticketClient,
      roundEvaluator: crossEvaluator,
      disclosureVerifier: new ApproveDisclosureVerifier(),
      authorization: stubAuth,
      repository,
      settlementService: settlementStub,
      telemetryBus: new TelemetryBus(),
      settlementAssetCode: "USDC",
      maxRounds: 12,
      deadlineMs: 60 * 60 * 1000,
    });
    const session = await repository.createSession({
      assetCode: ASSET,
      buyInstitutionId: BUY_INSTITUTION,
      sellInstitutionId: SELL_INSTITUTION,
      buyAgentDid: BUY_AGENT_DID,
      sellAgentDid: SELL_AGENT_DID,
      buyMandateId: "mandate-demo-buy",
      sellMandateId: "mandate-demo-sell",
      currentTurn: "buy",
      maxRounds: 12,
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    repository.registerDelegation(session.id, "buy", { id: "cred-demo-buyer" });
    repository.registerDelegation(session.id, "sell", { id: "cred-demo-seller" });

    // Open + reciprocal reveal of both claims, then accept.
    await orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId: session.id,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: { action: "propose", price: 70_000, quantity: 1, reasoning: "Open" },
      correlationRef: "test:recip:open",
    });
    for (const claim of reciprocalClaims) {
      await orchestrator.submitMove({
        institutionId: SELL_INSTITUTION,
        sessionId: session.id,
        agentId: "00000000-0000-4000-8000-00000000d102",
        agentDid: SELL_AGENT_DID,
        authorityRef: "auth-stub",
        move: {
          action: "reveal",
          claimType: claim,
          price: 70_000,
          quantity: 1,
          reasoning: `Reveal ${claim}`,
        },
        claimCredential: { claimType: claim, subject: SELL_AGENT_DID },
        correlationRef: `test:recip:seller-${claim}`,
      });
      await orchestrator.submitMove({
        institutionId: BUY_INSTITUTION,
        sessionId: session.id,
        agentId: "00000000-0000-4000-8000-00000000d101",
        agentDid: BUY_AGENT_DID,
        authorityRef: "auth-stub",
        move: {
          action: "reveal",
          claimType: claim,
          price: 70_000,
          quantity: 1,
          reasoning: `Reveal ${claim}`,
        },
        claimCredential: { claimType: claim, subject: BUY_AGENT_DID },
        correlationRef: `test:recip:buyer-${claim}`,
      });
    }
    const accepted = await orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId: session.id,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "accept",
        price: 70_000,
        quantity: 1,
        reasoning: "Reciprocal disclosure satisfied; accept.",
      },
      correlationRef: "test:recip:accept",
    });
    expect(accepted.status).toBe("settled");
  });

  it("fails closed when a session is missing its snapshotted delegation VCs (legacy / data-integrity)", async () => {
    // A session row whose `delegation_credentials` JSONB is
    // empty (legacy session, or the orchestrator's snapshot
    // failed) must not push a null-credential settlement
    // request to the settlement service. The orchestrator
    // aborts the session and marks it `expired`.
    const harness = await buildDemoHarness();
    const sessionId = await openDemoSession(harness);
    // Wipe the snapshot we registered in `openDemoSession`
    // to simulate a legacy session that pre-dates
    // migration 018.
    await harness.repository.updateSession({
      sessionId,
      patch: { delegation_credentials: {} },
    });
    const wiped = await harness.repository.getSessionRecord(sessionId);
    expect(wiped?.delegation_credentials).toEqual({});
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_000;
    harnessState.nextMatchedQuantity = 1;
    let settleCalls = 0;
    const settlementStub: Pick<SettlementService, "executeSettlement"> = {
      async executeSettlement() {
        settleCalls += 1;
        throw new Error(
          "settlement service should NOT be called when the snapshot is missing",
        );
      },
    };
    const orchestrator = new NegotiationOrchestrator({
      ticketClient: harness.ticketClient,
      roundEvaluator: crossEvaluator,
      disclosureVerifier: new ApproveDisclosureVerifier(),
      authorization: stubAuth,
      repository: harness.repository,
      settlementService: settlementStub as unknown as SettlementService,
      telemetryBus: new TelemetryBus(),
      settlementAssetCode: "USDC",
      maxRounds: 12,
      deadlineMs: 60 * 60 * 1000,
    });
    await orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: { action: "propose", price: 70_000, quantity: 1, reasoning: "Open" },
      correlationRef: "test:nodelegation:open",
    });
    await orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reciprocal reveal",
      },
      correlationRef: "test:nodelegation:reveal-buy",
    });
    await orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d101",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        reasoning: "Reciprocal reveal",
      },
      correlationRef: "test:nodelegation:reveal-sell",
    });
    const accepted = await orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000d102",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "accept",
        price: 70_000,
        quantity: 1,
        reasoning: "Accept",
      },
      correlationRef: "test:nodelegation:accept",
    });
    expect(accepted.status).toBe("expired");
    expect(settleCalls).toBe(0);
  });
});