import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NegotiationOrchestrator } from "../../services/negotiation-orchestrator.js";
import type { SettlementService } from "../../services/settlement.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import type {
  NegotiationPairVerificationRequest,
  NegotiationPairVerificationResult,
  NegotiationTicketClient,
  NegotiationRoundEvaluator,
  RoundEvaluationResult,
  RoundProposalDescriptor,
  NegotiationDisclosureVerifier,
} from "../../enclave/index.js";
import { InMemoryNegotiationRepository } from "../data/in-memory-negotiation-repository.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";
import type { NegotiationMandateRecord } from "../../models/negotiation.js";
import { sealEnvelope, loadEnvelopeMasterKey, type EnvelopeMasterKey } from "../../enclave/keys/envelope-cipher.js";

/**
 * Real AEAD test master key derived from the
 * ENVELOPE_ENCRYPTION_MASTER_KEY env var (set in vitest.config.ts).
 * Used to seal proposal envelopes so unit tests exercise the same
 * encrypt/decrypt path production code uses.
 */
const TEST_MASTER_KEY: EnvelopeMasterKey = loadEnvelopeMasterKey();

/**
 * Build a real AEAD-sealed proposal envelope for a test move.
 * Uses the same master key the orchestrator resolves at runtime
 * so the envelope round-trips through openEnvelope on the
 * production code path.
 */
function buildProposalEnvelope(
  side: "buy" | "sell",
  price: number,
  quantity: number,
): string {
  const institutionDid = side === "buy" ? BUY_INSTITUTION : SELL_INSTITUTION;
  const agentDid = side === "buy" ? BUY_AGENT_DID : SELL_AGENT_DID;
  return sealEnvelope({
    institutionDid,
    agentDid,
    authorityRef: "auth-stub",
    payload: {
      institutionId: institutionDid,
      agentDid,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side,
      quantity,
      price,
    },
    masterKey: TEST_MASTER_KEY,
  });
}

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

/**
 * Default TEE pair-verifier behavior: returns `compatible` for
 * any pair. Tests that exercise the rejection path replace
 * this behavior on a per-test basis via `vi.spyOn`.
 */
const ticketClient: NegotiationTicketClient = {
  async sealTicket() {
    return {
      ticketHandle: "ticket-stub",
      executionRef: "exec-stub",
      sealedAt: new Date().toISOString(),
      state: "ticket_sealed" as const,
    };
  },
  async verifyPair(
    request: NegotiationPairVerificationRequest,
  ): Promise<NegotiationPairVerificationResult> {
    const sorted = [request.buyTicketHandle, request.sellTicketHandle].sort();
    return {
      pairRef: `pair_default_${sorted[0]}_${sorted[1]}`,
      executionRef: "exec-pair-default",
      status: "compatible",
      reason: "",
      reasonCode: "",
      buyTicketHandle: request.buyTicketHandle,
      sellTicketHandle: request.sellTicketHandle,
      buyInstitutionId: "buy-inst",
      sellInstitutionId: "sell-inst",
      assetCode: request.assetCode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evaluatedAt: new Date().toISOString(),
    };
  },
};

const harnessState = {
  crossed: true,
  nextExecutionPrice: 70_100,
  nextMatchedQuantity: 1,
  /**
   * Side-keyed TEE-issued proposal handles. The stub round
   * evaluator mirrors the real TEE contract by minting a fresh
   * handle per `sealRoundProposal` call and using both side
   * handles on the subsequent `evaluateRound` call. Production
   * T3 hosts compute the handle from the envelope bytes inside
   * the enclave; the stub's deterministic handle per side
   * mirrors that for the cross-evaluation call.
   */
  nextHandle: 0,
  buyHandle: "round_buy_stub_handle_aaaaaaaaaaaaaaaa",
  sellHandle: "round_sell_stub_handle_bbbbbbbbbbbbbbbbbbbb",
};

const crossEvaluator: NegotiationRoundEvaluator = {
  async sealRoundProposal(input): Promise<RoundProposalDescriptor> {
    harnessState.nextHandle += 1;
    const sideHandle =
      input.side === "buy"
        ? harnessState.buyHandle
        : harnessState.sellHandle;
    return {
      proposalHandle: sideHandle,
      executionRef: `t3exec_seal_${harnessState.nextHandle}`,
      tradedAssetCode: input.assetCode,
      side: input.side,
      // Plaintext `quantity` / `price` in the descriptor are the
      // TEE-echoed values the enclave unsealed from the envelope.
      // Tests don't exercise the decode path, so the literal
      // strings are fine — they only need to round-trip through
      // the orchestrator without breaking types.
      distanceSignal: "far",
      attestationRef: `roundattest_seal_${harnessState.nextHandle}`,
      sealedAt: new Date().toISOString(),
    };
  },
  async evaluateRound(): Promise<RoundEvaluationResult> {
    return {
      status: harnessState.crossed ? ("crossed" as const) : ("open" as const),
      executionPrice: harnessState.nextExecutionPrice,
      matchedQuantity: harnessState.nextMatchedQuantity,
      buyerSignal: harnessState.crossed ? ("crossed" as const) : ("near" as const),
      sellerSignal: harnessState.crossed ? ("crossed" as const) : ("near" as const),
      outcomeRef: "outcome-stub",
      executionRef: "exec-stub",
      assetCodeCiphertext: "aead.v1:test:asset",
        quantityCiphertext: "aead.v1:test:qty",
        executionPriceCiphertext: "aead.v1:test:price",
        encryptedTradeFieldsRef: "fields-stub",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evaluatedAt: new Date().toISOString(),
      roundAttestationRef: "roundattest_stub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
  reciprocalDisclosureGate?: boolean;
}): Promise<Harness> {
  const repository = new InMemoryNegotiationRepository();
  if (options.reciprocalDisclosureGate === true) {
    const requiredClaims = ["accredited_institution", "settlement_capacity"];
    repository.registerMandate({
      ...buyMandateRecord(options.approvalMode),
      counterparty_requirements: { requiredClaims, disallowedTraits: [] },
      disclosure_policy: {
        allowLadder: requiredClaims,
        requireReciprocityFor: ["settlement_capacity"],
      },
      disclosable_claims: requiredClaims,
    });
    repository.registerMandate({
      ...sellMandateRecord(),
      counterparty_requirements: { requiredClaims, disallowedTraits: [] },
      disclosure_policy: {
        allowLadder: requiredClaims,
        requireReciprocityFor: ["settlement_capacity"],
      },
      disclosable_claims: requiredClaims,
    });
  } else {
    repository.registerMandate(buyMandateRecord(options.approvalMode));
    repository.registerMandate(sellMandateRecord());
  }
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
    agentRepository: new FakeAgentRepository(),
    envelopeMasterKeyHex: "0".repeat(64),
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_080, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 70_090, 1),
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_080, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 71_000, 1),
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_080, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 71_000, 1),
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_080, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 71_000, 1),
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_020, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 70_050, 1),
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
  it("settles end to end after reciprocal accredited institution and settlement capacity disclosures", async () => {
    const harness = await buildHarness({
      approvalMode: "auto_settle",
      reciprocalDisclosureGate: true,
    });
    const sessionId = await openSession(harness);
    harnessState.crossed = true;
    harnessState.nextExecutionPrice = 70_000;
    harnessState.nextMatchedQuantity = 1;

    const buyerOpen = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "propose",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("buy", 70_000, 1),
        reasoning: "Open at the shared anchor.",
        escalationRequested: false,
      },
      correlationRef: "test:e2e:buyer-open",
    });
    expect(buyerOpen.status).toBe("active");

    const sellerRevealInstitution = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("sell", 70_000, 1),
        reasoning: "Reveal institution status before settlement.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: SELL_AGENT_DID },
      correlationRef: "test:e2e:seller-reveal-institution",
    });
    expect(sellerRevealInstitution.status).toBe("active");

    const buyerRequestCapacity = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "request_disclosure",
        claimType: "settlement_capacity",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("buy", 70_000, 1),
        reasoning: "Request seller settlement capacity.",
        escalationRequested: false,
      },
      correlationRef: "test:e2e:buyer-request-capacity",
    });
    expect(buyerRequestCapacity.status).toBe("active");

    const sellerRevealCapacity = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "settlement_capacity",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("sell", 70_000, 1),
        reasoning: "Reveal seller settlement capacity.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "settlement_capacity", subject: SELL_AGENT_DID },
      correlationRef: "test:e2e:seller-reveal-capacity",
    });
    expect(sellerRevealCapacity.status).toBe("active");

    const buyerRevealInstitution = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "accredited_institution",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("buy", 70_000, 1),
        reasoning: "Reveal buyer institution status.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "accredited_institution", subject: BUY_AGENT_DID },
      correlationRef: "test:e2e:buyer-reveal-institution",
    });
    expect(buyerRevealInstitution.status).toBe("active");

    const sellerRequestCapacity = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "request_disclosure",
        claimType: "settlement_capacity",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("sell", 70_000, 1),
        reasoning: "Request buyer settlement capacity.",
        escalationRequested: false,
      },
      correlationRef: "test:e2e:seller-request-capacity",
    });
    expect(sellerRequestCapacity.status).toBe("active");

    const buyerRevealCapacity = await harness.orchestrator.submitMove({
      institutionId: BUY_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "reveal",
        claimType: "settlement_capacity",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("buy", 70_000, 1),
        reasoning: "Reveal buyer settlement capacity.",
        escalationRequested: false,
      },
      claimCredential: { claimType: "settlement_capacity", subject: BUY_AGENT_DID },
      correlationRef: "test:e2e:buyer-reveal-capacity",
    });
    expect(buyerRevealCapacity.status).toBe("active");

    const sellerAccept = await harness.orchestrator.submitMove({
      institutionId: SELL_INSTITUTION,
      sessionId,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      move: {
        action: "accept",
        price: 70_000,
        quantity: 1,
        proposalEnvelope: buildProposalEnvelope("sell", 70_000, 1),
        reasoning: "All reciprocal proof is verified; accept crossed terms.",
        escalationRequested: false,
      },
      correlationRef: "test:e2e:seller-accept",
    });
    expect(sellerAccept.status).toBe("settled");

    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("settled");
    expect(session?.trade_ref).toMatch(/^trade-/);
    expect(harness.repository.tradeLinks.get(sessionId)).toBe(session?.trade_ref);
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
      { fromSide: "sell", claimType: "settlement_capacity", verified: true },
      { fromSide: "buy", claimType: "accredited_institution", verified: true },
      { fromSide: "buy", claimType: "settlement_capacity", verified: true },
    ]);
  });

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
        proposalEnvelope: buildProposalEnvelope("buy", 70_020, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 70_050, 1),
        reasoning: "Meet",
      },
      correlationRef: "test:seller:1",
    });
    expect(seller.status).toBe("settled");
  });

  it("does not let a side's own disclosure satisfy its counterparty proof gate", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    const sessionId = await openSession(harness);
    await harness.repository.appendDisclosure({
      sessionId,
      fromDid: BUY_AGENT_DID,
      fromSide: "buy",
      claimType: "accredited_institution",
      claimAssertionCiphertext: "ct-buyer",
      verified: true,
      t3AttestationRef: "att-buyer",
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_020, 1),
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
        proposalEnvelope: buildProposalEnvelope("sell", 70_050, 1),
        reasoning: "Meet",
      },
      correlationRef: "test:seller:1",
    });
    expect(seller.status).toBe("active");
    const session = await harness.repository.getSessionRecord(sessionId);
    expect(session?.status).toBe("active");
    expect(session?.trade_ref).toBeNull();
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

describe("NegotiationOrchestrator — TEE pair authority", () => {
  beforeEach(() => {
    // Reset the spy on `verifyPair` so each test starts
    // from a clean call history. The default behavior on the
    // underlying `ticketClient.verifyPair` is `compatible` (see
    // the module-level stub), which is what the existing
    // escalation / disclosure tests rely on.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consults the TEE verifyPair before pairing and pairs on a compatible verdict", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    // Spy on the TEE pair verifier. The default harness uses a
    // "compatible" stub, so we just record the call shape.
    const verifyPair = vi.spyOn(ticketClient, "verifyPair");
    const buyerTicket = await harness.orchestrator.submitTicket({
      institutionId: BUY_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "buy",
      compatibilityToken: `${ASSET}:buy:${BUY_INSTITUTION}`,
      correlationRef: "test:tee:buyer",
    });
    expect(buyerTicket.sessionId).toBeNull();
    const sellerTicket = await harness.orchestrator.submitTicket({
      institutionId: SELL_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "sell",
      compatibilityToken: `${ASSET}:sell:${SELL_INSTITUTION}`,
      correlationRef: "test:tee:seller",
    });
    expect(sellerTicket.sessionId).not.toBeNull();
    expect(verifyPair).toHaveBeenCalledTimes(1);
    const call = verifyPair.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.buyTicketHandle).toBe(buyerTicket.ticketHandle);
    expect(call?.sellTicketHandle).toBe(sellerTicket.ticketHandle);
    expect(call?.buyCompatibilityToken).toBe(`${ASSET}:buy:${BUY_INSTITUTION}`);
    expect(call?.sellCompatibilityToken).toBe(`${ASSET}:sell:${SELL_INSTITUTION}`);
    expect(call?.assetCode).toBe(ASSET);
  });

  it("does not pair when the TEE returns incompatible and keeps both tickets pending", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    // Override the pair verifier to reject any pair with a
    // stable reason code. The TEE's reason codes are part of
    // the public contract surface (see the WIT world.wit), so
    // we test against one of the documented codes.
    const verifyPair = vi
      .spyOn(ticketClient, "verifyPair")
      .mockResolvedValueOnce({
        pairRef: "pair_rejected",
        executionRef: "exec-rejected",
        status: "incompatible",
        reason: "buy and sell compatibility tokens reference the same institution",
        reasonCode: "same_institution",
        buyTicketHandle: "ticket-buy",
        sellTicketHandle: "ticket-sell",
        buyInstitutionId: "",
        sellInstitutionId: "",
        assetCode: ASSET,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        evaluatedAt: new Date().toISOString(),
      });
    const buyer = await harness.orchestrator.submitTicket({
      institutionId: BUY_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "buy",
      compatibilityToken: `${ASSET}:buy:${BUY_INSTITUTION}`,
      correlationRef: "test:tee-rej:buyer",
    });
    expect(buyer.sessionId).toBeNull();
    const seller = await harness.orchestrator.submitTicket({
      institutionId: SELL_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "sell",
      compatibilityToken: `${ASSET}:sell:${SELL_INSTITUTION}`,
      correlationRef: "test:tee-rej:seller",
    });
    expect(seller.sessionId).toBeNull();
    expect(verifyPair).toHaveBeenCalledTimes(1);
    // The two tickets must remain pending so a later, valid
    // candidate (e.g. an updated compatibility token) can
    // retry without re-submission.
    const sessions = await harness.repository.listSessions(BUY_INSTITUTION);
    expect(sessions).toHaveLength(0);
  });

  it("rejects a TEE pair verifier error as a hard gate (does not create a session)", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    vi.spyOn(ticketClient, "verifyPair").mockRejectedValueOnce(
      new Error("T3 host unreachable"),
    );
    await harness.orchestrator.submitTicket({
      institutionId: BUY_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "buy",
      compatibilityToken: `${ASSET}:buy:${BUY_INSTITUTION}`,
      correlationRef: "test:tee-err:buyer",
    });
    await expect(
      harness.orchestrator.submitTicket({
        institutionId: SELL_INSTITUTION,
        agentId: "00000000-0000-4000-8000-00000000a002",
        agentDid: SELL_AGENT_DID,
        authorityRef: "auth-stub",
        assetCode: ASSET,
        side: "sell",
        compatibilityToken: `${ASSET}:sell:${SELL_INSTITUTION}`,
        correlationRef: "test:tee-err:seller",
      }),
    ).rejects.toThrow("T3 host unreachable");
    const sessions = await harness.repository.listSessions(BUY_INSTITUTION);
    expect(sessions).toHaveLength(0);
  });

  it("passes both sides' compatibility tokens verbatim to the TEE verifier", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
    const verifyPair = vi.spyOn(ticketClient, "verifyPair");
    const buyToken = `${ASSET}:buy:${BUY_INSTITUTION}`;
    const sellToken = `${ASSET}:sell:${SELL_INSTITUTION}`;
    await harness.orchestrator.submitTicket({
      institutionId: BUY_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a001",
      agentDid: BUY_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "buy",
      compatibilityToken: buyToken,
      correlationRef: "test:tee-tokens:buyer",
    });
    await harness.orchestrator.submitTicket({
      institutionId: SELL_INSTITUTION,
      agentId: "00000000-0000-4000-8000-00000000a002",
      agentDid: SELL_AGENT_DID,
      authorityRef: "auth-stub",
      assetCode: ASSET,
      side: "sell",
      compatibilityToken: sellToken,
      correlationRef: "test:tee-tokens:seller",
    });
    expect(verifyPair).toHaveBeenCalledTimes(1);
    const call = verifyPair.mock.calls[0]?.[0];
    expect(call?.buyCompatibilityToken).toBe(buyToken);
    expect(call?.sellCompatibilityToken).toBe(sellToken);
  });
});

describe("NegotiationOrchestrator — privacy boundary on logs", () => {
  it("does not emit plaintext trading parameters to stdout during a priced move cycle", async () => {
    const harness = await buildHarness({ approvalMode: "auto_settle" });
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
    harnessState.nextExecutionPrice = 70_050;
    harnessState.nextMatchedQuantity = 1;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
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
        proposalEnvelope: buildProposalEnvelope("buy", 70_020, 1),
          reasoning: "Open",
        },
        correlationRef: "test:privacy:buyer",
      });
      await harness.orchestrator.submitMove({
        institutionId: SELL_INSTITUTION,
        sessionId,
        agentId: "00000000-0000-4000-8000-00000000a002",
        agentDid: SELL_AGENT_DID,
        authorityRef: "auth-stub",
        move: {
          action: "counter",
          price: 70_050,
          quantity: 1,
        proposalEnvelope: buildProposalEnvelope("sell", 70_050, 1),
          reasoning: "Meet",
        },
        correlationRef: "test:privacy:seller",
      });
    } finally {
      consoleSpy.mockRestore();
    }

    const allCalls = consoleSpy.mock.calls
      .map((call) => call.map((part) => String(part)).join(" "))
      .join("\n");
    // The orchestrator must never print plaintext trading
    // parameters on stdout. Any of these tokens leaking would be
    // a P0 privacy regression per plan.md §Constraints.
    expect(allCalls).not.toMatch(/\b70020\b/);
    expect(allCalls).not.toMatch(/\b70050\b/);
    expect(allCalls).not.toMatch(/\bprice=/u);
    expect(allCalls).not.toMatch(/\bqty=/u);
    expect(allCalls).not.toMatch(/\bexecPrice=/u);
    expect(allCalls).not.toMatch(/\bmatchedQty=/u);
  });
});
