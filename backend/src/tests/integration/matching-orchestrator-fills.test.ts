import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BlindIntentClient,
  BlindIntentRequest,
  BlindIntentResult,
  MatchContractClient,
  MatchEvaluationRequest,
  OpaqueMatchOutcome,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import type { AgentRepository } from "../../services/agent-repository.js";
import { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import { PortfolioService } from "../../services/portfolio.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type {
  SettlementExecutionRequest,
  SettlementService,
} from "../../services/settlement.service.js";
import type { CompletedTrade } from "../../models/completed-trade.js";
import { buildHiddenIntentRequest } from "../data/us2-encrypted-intent-builders.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";
import { InMemoryIntentLockClient } from "../support/in-memory-intent-lock-client.js";

const buyerId = "00000000-0000-4000-8000-0000000007a1";
const sellerId = "00000000-0000-4000-8000-0000000007a2";

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: request.authorityRef,
      policyHash: "policy:fills",
    };
  }
}

class StaticBlindIntentClient implements BlindIntentClient {
  public counter = 0;
  public async sealIntent(
    _request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    void _request;
    this.counter++;
    return {
      intentHandle: `intent_opaque_${this.counter}`,
      state: "intent_sealed",
      executionRef: `t3exec_${this.counter}`,
      sealedAt: new Date().toISOString(),
    };
  }
}

class MatchedClient implements MatchContractClient {
  public calls = 0;
  public async evaluateMatch(
    _request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
    void _request;
    this.calls++;
    // The TEE returns empty buyer/seller fields; the orchestrator
    // normalizes them from its queue before settlement.
    return {
      status: "matched",
      outcomeRef: `outcome_${this.calls}`,
      executionRef: `exec_${this.calls}`,
      buyerInstitutionId: "",
      sellerInstitutionId: "",
      encryptedTradeFieldsRef: `fields_${this.calls}`,
      buyerAuthorityRef: "",
      sellerAuthorityRef: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

/**
 * A faithful settlement stub: it forwards the matched per-side lock
 * amounts the orchestrator computed into the same
 * `persist_completed_settlement` RPC the production
 * SupabaseSettlementRepository calls, so the balance + lock math is
 * exercised end to end. Returns a minimal CompletedTrade.
 */
class ForwardingSettlement
  implements Pick<SettlementService, "executeSettlement">
{
  public constructor(private readonly client: InMemoryPortfolioClient) {}
  public requests: SettlementExecutionRequest[] = [];
  public async executeSettlement(
    request: SettlementExecutionRequest,
  ): Promise<CompletedTrade> {
    this.requests.push(request);
    const { error } = await this.client.rpc("persist_completed_settlement", {
      completed_trade: {
        trade_ref: request.matchOutcome.outcomeRef,
        buy_institution_id: request.matchOutcome.buyerInstitutionId,
        sell_institution_id: request.matchOutcome.sellerInstitutionId,
      },
      receipts: [],
      settlement_plaintext: {
        buyer_institution_id: request.matchOutcome.buyerInstitutionId,
        seller_institution_id: request.matchOutcome.sellerInstitutionId,
        asset_code: request.assetCode,
        quantity: request.quantity,
        execution_price: request.executionPrice,
        buyer_locked_amount: request.buyerLockedAmount,
        seller_locked_amount: request.sellerLockedAmount,
      },
    });
    if (error) {
      throw error;
    }
    return {
      id: "00000000-0000-4000-8000-0000000007ff",
      tradeRef: request.matchOutcome.outcomeRef,
      assetCodeCiphertext: "x",
      quantityCiphertext: "x",
      executionPriceCiphertext: "x",
      settledAt: new Date().toISOString(),
      settlementStatus: "settled",
      railId: null,
      railTradeRef: null,
      railState: null,
      receiptIds: [],
    };
  }
}

class NoMatchClient implements MatchContractClient {
  public calls = 0;
  public async evaluateMatch(): Promise<OpaqueMatchOutcome> {
    this.calls++;
    return {
      status: "no_match",
      outcomeRef: "",
      executionRef: "",
      buyerInstitutionId: "",
      sellerInstitutionId: "",
      encryptedTradeFieldsRef: "",
      buyerAuthorityRef: "",
      sellerAuthorityRef: "",
      expiresAt: new Date(0).toISOString(),
    };
  }
}

function buildStack(
  client: InMemoryPortfolioClient,
  matchClient: MatchContractClient,
  settlement: Pick<SettlementService, "executeSettlement">,
  lockClient: InMemoryIntentLockClient,
  agentRepository?: AgentRepository,
): { service: HiddenIntentService; orchestrator: MatchingOrchestrator } {
  const portfolioService = new PortfolioService(client as never, "USDC");
  const orchestrator = new MatchingOrchestrator(
    matchClient,
    settlement as unknown as SettlementService,
    new TelemetryBus(),
    portfolioService,
    "USDC",
    undefined,
    undefined,
    lockClient as never,
  );
  const service = new HiddenIntentService(
    new VerifiedAuthorization(),
    new StaticBlindIntentClient(),
    new TelemetryBus(),
    undefined,
    orchestrator,
    agentRepository,
    portfolioService,
    lockClient as never,
  );
  return { service, orchestrator };
}

describe("matching orchestrator - fills and crossing", () => {
  it("does not match when the buyer's bid is below the seller's ask", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
    ]);
    const matchClient = new NoMatchClient();
    const lockClient = new InMemoryIntentLockClient();
    const { service, orchestrator } = buildStack(
      client,
      matchClient,
      { executeSettlement: async () => { throw new Error("must not settle"); } },
      lockClient,
    );

    // Buyer bids 40000, seller asks 50000 -> no cross.
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        settlementMetadata: { assetCode: "WBTC", side: "buy", quantity: 10, price: 40000 },
      }),
      { correlationRef: "corr_x_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-x",
        settlementMetadata: { assetCode: "WBTC", side: "sell", quantity: 10, price: 50000 },
      }),
      { correlationRef: "corr_x_sell" },
    );
    await new Promise((r) => setTimeout(r, 30));

    // The TEE match contract was never even consulted: the
    // crossing guard short-circuits first.
    expect(matchClient.calls).toBe(0);
    expect(orchestrator.pendingCount()).toBe(2);
  });

  it("partially fills the larger intent and keeps the residual lock correct", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    const matchClient = new MatchedClient();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const { service, orchestrator } = buildStack(client, matchClient, settlement, lockClient);
    const portfolioService = new PortfolioService(client as never, "USDC");

    // Buyer wants 10 @ 50000 -> locks 500000 USDC.
    const buyAccepted = await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        settlementMetadata: { assetCode: "WBTC", side: "buy", quantity: 10, price: 50000 },
      }),
      { correlationRef: "corr_pf_buy" },
    );
    // Seller offers only 4 @ 50000 -> locks 4 WBTC. Match qty = 4.
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-pf",
        settlementMetadata: { assetCode: "WBTC", side: "sell", quantity: 4, price: 50000 },
      }),
      { correlationRef: "corr_pf_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Match price = midpoint = 50000. Settlement moved 4 WBTC for
    // 200000 USDC.
    const buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    const buyerCash = buyerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    // Buyer paid 4*50000 = 200000, and the matched lock portion
    // (4*50000 = 200000) was released, leaving the residual
    // 6*50000 = 300000 still locked.
    expect(buyerCash).toEqual({
      assetCode: "USDC",
      balance: 99_800_000,
      locked: 300_000,
    });
    const buyerAsset = buyerPortfolio.holdings.find((h) => h.assetCode === "WBTC");
    expect(buyerAsset?.balance).toBe(4);

    // Seller fully filled: no WBTC lock remains, received 200000 USDC.
    const sellerPortfolio = await portfolioService.getPortfolio(sellerId);
    expect(sellerPortfolio.holdings.find((h) => h.assetCode === "WBTC")).toEqual({
      assetCode: "WBTC",
      balance: 996,
      locked: 0,
    });
    expect(sellerPortfolio.holdings.find((h) => h.assetCode === "USDC")?.balance).toBe(200_000);

    // The buyer's intent stays queued with the residual quantity;
    // the seller's intent is gone.
    expect(orchestrator.pendingCount()).toBe(1);

    // The durable lock ref for the buyer now tracks the residual
    // 300000 USDC, and the seller's ref was deleted.
    const buyerLockRow = lockClient.rows.find(
      (r) => r.intent_handle === buyAccepted.intentHandle,
    );
    expect(buyerLockRow?.amount).toBe("300000");
    expect(lockClient.rows).toHaveLength(1);
  });

  it("passes persisted delegation credentials through to settlement", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    const matchClient = new MatchedClient();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const buyerCredential = { id: "buyer-credential" };
    const sellerCredential = { id: "seller-credential" };
    const agentRepository = {
      findByAgentDid: async (institutionId: string, agentDid: string) => {
        if (institutionId === buyerId && agentDid === "did:t3n:agent:buyer-cred") {
          return { metadata: { delegation_credential: buyerCredential } } as never;
        }
        if (institutionId === sellerId && agentDid === "did:t3n:agent:seller-cred") {
          return { metadata: { delegation_credential: sellerCredential } } as never;
        }
        return null;
      },
    } as AgentRepository;
    const { service } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
      agentRepository,
    );

    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        agentDid: "did:t3n:agent:buyer-cred",
        authorityRef: "authority:buyer-cred",
        settlementMetadata: {
          assetCode: "WBTC",
          side: "buy",
          quantity: 4,
          price: 50000,
        },
      }),
      { correlationRef: "corr_cred_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-cred",
        authorityRef: "authority:seller-cred",
        settlementMetadata: {
          assetCode: "WBTC",
          side: "sell",
          quantity: 4,
          price: 50000,
        },
      }),
      { correlationRef: "corr_cred_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    expect(settlement.requests[0]?.buyerDelegationCredential).toEqual(buyerCredential);
    expect(settlement.requests[0]?.sellerDelegationCredential).toEqual(sellerCredential);
    });
});
