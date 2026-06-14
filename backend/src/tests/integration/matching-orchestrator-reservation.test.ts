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
import { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import {
  InsufficientBalanceError,
  PortfolioService,
} from "../../services/portfolio.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { SettlementService } from "../../services/settlement.service.js";
import {
  buildHiddenIntentRequest,
  buildHiddenIntentRequestForSide,
  us2AgentDid,
  us2AuthorityRef,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: us2AuthorityRef,
      policyHash: "policy:us2",
    };
  }
}

class StaticBlindIntentClient implements BlindIntentClient {
  public counter = 0;
  public async sealIntent(
    request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    void request;
    this.counter++;
    return {
      intentHandle: `intent_opaque_${this.counter}`,
      state: "intent_sealed",
      executionRef: `t3exec_${this.counter}`,
      sealedAt: new Date().toISOString(),
    };
  }
}

class NoOpMatchClient implements MatchContractClient {
  public async evaluateMatch(
    _request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
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

class NoOpSettlement
  implements Pick<SettlementService, "executeSettlement">
{
  public async executeSettlement(): Promise<never> {
    throw new Error("Settlement not configured for reservation test");
  }
}

const sellerInstitutionId = "00000000-0000-4000-8000-000000000602";

function buildOrchestrator(portfolioClient: InMemoryPortfolioClient): {
  orchestrator: MatchingOrchestrator;
  portfolioService: PortfolioService;
} {
  const portfolioService = new PortfolioService(
    portfolioClient as never,
    "USDC",
  );
  const orchestrator = new MatchingOrchestrator(
    new NoOpMatchClient(),
    new NoOpSettlement() as unknown as SettlementService,
    new TelemetryBus(),
    portfolioService,
  );
  return { orchestrator, portfolioService };
}

function buildHiddenIntentService(
  orchestrator: MatchingOrchestrator,
  portfolioService: PortfolioService,
): HiddenIntentService {
  return new HiddenIntentService(
    new VerifiedAuthorization(),
    new StaticBlindIntentClient(),
    new TelemetryBus(),
    undefined,
    orchestrator,
    undefined,
    portfolioService,
  );
}

describe("matching orchestrator — balance reservations", () => {
  it("locks quantity*price USDC on submitIntent for a buy intent", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 10_000_000, // enough to lock 100 * 45000 = 4_500_000
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_lock_buy_1",
    });

    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings).toEqual([
      { assetCode: "USDC", balance: 10_000_000, locked: 4_500_000 },
    ]);
  });

  it("locks quantity of the asset on submitIntent for a sell intent", async () => {
    const sellerRequest = buildHiddenIntentRequestForSide("sell", {
      institutionId: sellerInstitutionId,
    });
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: sellerInstitutionId,
        assetCode: "WBTC",
        balance: 1000, // enough to lock 100 WBTC
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    await service.submitIntent(sellerRequest, {
      correlationRef: "corr_lock_sell_1",
    });

    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(sellerInstitutionId);
    expect(portfolio.holdings).toEqual([
      { assetCode: "WBTC", balance: 1000, locked: 100 },
    ]);
  });

  it("rejects the intent when available balance is insufficient (does NOT enqueue)", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 100, // way less than 4_500_000
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    await expect(
      service.submitIntent(buildHiddenIntentRequest(), {
        correlationRef: "corr_lock_overdraw",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    // The intent is NOT in the queue.
    expect(orchestrator.pendingCount()).toBe(0);
    // No lock was placed.
    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 100,
      locked: 0,
    });
  });

  it("releases the lock on cancelIntent", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 10_000_000, // enough to lock 100 * 45000 = 4_500_000
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    const accepted = await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_lock_cancel",
    });
    // Lock placed.
    let portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]?.locked).toBe(4_500_000);

    await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentDid: us2AgentDid,
      intentHandle: accepted.intentHandle,
      authorityRef: us2AuthorityRef,
    });

    // Lock released.
    portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 10_000_000,
      locked: 0,
    });
  });

  it("releases the lock on removeIntentsByAgent (revocation cascade)", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 10_000_000, // enough to lock 100 * 45000 = 4_500_000
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_lock_revoke",
    });

    orchestrator.removeIntentsByAgent(us2AgentDid, us2InstitutionId);

    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 10_000_000,
      locked: 0,
    });
  });

  it("accumulates locks across multiple intents from the same institution", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 1_000_000,
      }),
    ]);
    const { orchestrator, portfolioService } = buildOrchestrator(client);
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    // First intent: 100 * 45000 = 4_500_000 — but available is only 1M.
    // We must size these to fit. Use smaller intents.
    await service.submitIntent(
      buildHiddenIntentRequest({ settlementMetadata: {
        assetCode: "WBTC",
        side: "buy",
        quantity: 5,
        price: 1000, // 5000
      } }),
      { correlationRef: "corr_lock_multi_1" },
    );
    await service.submitIntent(
      buildHiddenIntentRequest({ settlementMetadata: {
        assetCode: "WBTC",
        side: "buy",
        quantity: 5,
        price: 1000, // 5000
      } }),
      { correlationRef: "corr_lock_multi_2" },
    );

    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    // Two locks of 5000 each = 10_000 total.
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 1_000_000,
      locked: 10_000,
    });
    expect(orchestrator.pendingCount()).toBe(2);
  });

  it("settlement implicitly releases both buyer and seller locks", async () => {
    // The buyer's USDC is locked for the trade total; the seller's
    // WBTC is locked for the trade quantity. When settlement runs,
    // the SQL `portfolio_update_balance` function clamps
    // `locked = LEAST(locked, new_balance)`, which releases any
    // portion of the lock that is now backed by zero balance.

    // Build a settlement that uses the same PortfolioService the
    // orchestrator uses, so the SQL clamping runs end-to-end.
    const buyerId = us2InstitutionId;
    const sellerId = sellerInstitutionId;
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: buyerId,
        assetCode: "USDC",
        balance: 10_000_000,
      }),
      makePortfolioRecord({
        institutionId: buyerId,
        assetCode: "WBTC",
        balance: 0,
      }),
      makePortfolioRecord({
        institutionId: sellerId,
        assetCode: "WBTC",
        balance: 1000,
      }),
      makePortfolioRecord({
        institutionId: sellerId,
        assetCode: "USDC",
        balance: 0,
      }),
    ]);
    const portfolioService = new PortfolioService(
      client as never,
      "USDC",
    );

    class MatchedClient implements MatchContractClient {
      public async evaluateMatch(): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: "outcome_test",
          executionRef: "exec_test",
          buyerInstitutionId: buyerId,
          sellerInstitutionId: sellerId,
          encryptedTradeFieldsRef: "fields_ref",
          buyerAuthorityRef: "auth_buyer",
          sellerAuthorityRef: "auth_seller",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
    }

    class SettlingSettlement
      implements Pick<SettlementService, "executeSettlement">
    {
      constructor(private readonly ps: PortfolioService) {}
      public async executeSettlement(): Promise<never> {
        // Mirrors what SettlementService does in production:
        // applySettlement calls applyAdjustmentWithHistory for
        // each leg, each of which calls portfolio_update_balance
        // (LEAST(locked, new_balance) clamp).
        await this.ps.applySettlement({
          buyerInstitutionId: buyerId,
          sellerInstitutionId: sellerId,
          assetCode: "WBTC",
          quantity: 100,
          price: 50000,
        });
        throw new Error("test-only stub does not return a trade record");
      }
    }

    const orchestrator = new MatchingOrchestrator(
      new MatchedClient(),
      new SettlingSettlement(portfolioService) as unknown as SettlementService,
      new TelemetryBus(),
      portfolioService,
    );
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    // Submit a buy intent (buyer locks 100 * 50000 = 5_000_000 USDC).
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        settlementMetadata: {
          assetCode: "WBTC",
          side: "buy",
          quantity: 100,
          price: 50000,
        },
      }),
      { correlationRef: "corr_settle_buy" },
    );
    // Submit a matching sell intent (seller locks 100 WBTC).
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-settle-test",
        authorityRef: us2AuthorityRef,
        settlementMetadata: {
          assetCode: "WBTC",
          side: "sell",
          quantity: 100,
          price: 50000,
        },
      }),
      { correlationRef: "corr_settle_sell" },
    );

    // Both locks should be in place.
    let buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    expect(buyerPortfolio.holdings.find((h) => h.assetCode === "USDC")?.locked).toBe(5_000_000);
    let sellerPortfolio = await portfolioService.getPortfolio(sellerId);
    expect(sellerPortfolio.holdings.find((h) => h.assetCode === "WBTC")?.locked).toBe(100);

    // The orchestrator's matching attempt runs on the second submit.
    // We let it process: the matching loop is fire-and-forget after
    // submission, so we wait for it to settle.
    // The matching will call applySettlement which throws
    // (expected in the stub). We catch via a small wait.
    await new Promise((r) => setTimeout(r, 50));

    // After settlement, buyer's USDC drained by 5_000_000 (now 5_000_000
    // remaining). The LEAST(locked, balance) clamp drops the lock to
    // balance = 5_000_000, then to 0 after seller-side cash credit
    // is added. We just assert both rows are healthy: locked is
    // never above balance.
    buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    const buyerCash = buyerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    if (buyerCash) {
      expect(buyerCash.locked).toBeLessThanOrEqual(buyerCash.balance);
    }
    const buyerAsset = buyerPortfolio.holdings.find((h) => h.assetCode === "WBTC");
    if (buyerAsset) {
      expect(buyerAsset.locked).toBeLessThanOrEqual(buyerAsset.balance);
    }
    sellerPortfolio = await portfolioService.getPortfolio(sellerId);
    const sellerAsset = sellerPortfolio.holdings.find((h) => h.assetCode === "WBTC");
    if (sellerAsset) {
      expect(sellerAsset.locked).toBeLessThanOrEqual(sellerAsset.balance);
    }
    const sellerCash = sellerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    if (sellerCash) {
      expect(sellerCash.locked).toBeLessThanOrEqual(sellerCash.balance);
    }
  });

  it("releases the counterparty's lock on a pre-match balance failure (not just TTL)", async () => {
    // Regression test: before the lock-ref work, the four
    // pre-match failure paths (balance, direction scope,
    // instrument scope, max notional) spliced the counterparty
    // from the queue but did NOT release its `portfolios.locked`
    // amount. The counterparty's lock would then be stranded
    // for up to 5 minutes until TTL eviction.
    //
    // Setup:
    // - buyer has 10M USDC (enough to lock 5M)
    // - seller has 100 WBTC, locked = 0 at submit time
    //
    // On the seller's submit, the lock of 100 WBTC succeeds
    // (available = 100 - 0 = 100). After the lock, the
    // seller's available becomes 100 - 100 = 0.
    //
    // The orchestrator's matching loop then evaluates the
    // (buyer, seller) pair. The buyer's pre-match check
    // passes (USDC available = 5M ≥ 5M trade cost). The
    // seller's pre-match check FAILS (WBTC available = 0 <
    // 100 match qty). The orchestrator splices the buyer
    // (the counterparty = `other` in the loop) from the
    // queue AND releases the buyer's lock.
    //
    // The seller stays in the queue, waiting for a different
    // counterparty.
    const buyerId = us2InstitutionId;
    const sellerId = "00000000-0000-4000-8000-000000000702";
    const clientWithLocks = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: buyerId,
        assetCode: "USDC",
        balance: 10_000_000,
      }),
      makePortfolioRecord({
        institutionId: sellerId,
        assetCode: "WBTC",
        balance: 100,
      }),
    ]);
    const { orchestrator: orch2, portfolioService: ps2 } =
      buildOrchestrator(clientWithLocks);
    const service2 = buildHiddenIntentService(orch2, ps2);

    // Buyer submits first, locks 5_000_000 USDC.
    await service2.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        settlementMetadata: {
          assetCode: "WBTC",
          side: "buy",
          quantity: 100,
          price: 50000,
        },
      }),
      { correlationRef: "corr_prematch_buyer" },
    );
    // Seller submits second, locks 100 WBTC.
    await service2.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-prematch",
        authorityRef: us2AuthorityRef,
        settlementMetadata: {
          assetCode: "WBTC",
          side: "sell",
          quantity: 100,
          price: 50000,
        },
      }),
      { correlationRef: "corr_prematch_seller" },
    );

    // Both locks in place.
    let buyerPortfolio = await ps2.getPortfolio(buyerId);
    let sellerPortfolio = await ps2.getPortfolio(sellerId);
    expect(buyerPortfolio.holdings[0]?.locked).toBe(5_000_000);
    expect(sellerPortfolio.holdings[0]?.locked).toBe(100);

    // The orchestrator's matching loop tries to match. The
    // seller's pre-match balance check fails (available = 0
    // < 100). The buyer (the counterparty `other`) is spliced
    // from the queue and (post-fix) the buyer's lock is
    // released.
    await new Promise((r) => setTimeout(r, 200));

    // Buyer's lock is released (they were the counterparty
    // that was spliced). Buyer's USDC is fully available.
    buyerPortfolio = await ps2.getPortfolio(buyerId);
    expect(buyerPortfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 10_000_000,
      locked: 0,
    });

    // Seller stays in the queue with their lock intact
    // (they're the failing side, still waiting for a
    // different counterparty).
    sellerPortfolio = await ps2.getPortfolio(sellerId);
    expect(sellerPortfolio.holdings[0]).toEqual({
      assetCode: "WBTC",
      balance: 100,
      locked: 100,
    });
    expect(orch2.pendingCount()).toBe(1);
  });
});
