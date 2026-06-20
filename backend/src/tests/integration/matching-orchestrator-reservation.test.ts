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
} from "../../enclave/index.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import {
  InsufficientBalanceError,
  PortfolioService,
} from "../../services/portfolio.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { SettlementService } from "../../services/settlement.service.js";
import type { AgentRepository } from "../../services/agent-repository.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";
import {
  buildHiddenIntentRequest,
  buildHiddenIntentRequestForSide,
  us2AgentDid,
  us2AgentId,
  us2AuthorityRef,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

/**
 * Build a canonical `ghostbroker.envelope/1` envelope with the
 * given trading parameters. The in-process test path uses
 * envelopes built by `buildSealedEnvelope` so the seal stub
 * can re-derive the lock descriptor without needing a live TEE.
 */
function makeEnvelope(
  assetCode: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
): string {
  const json = JSON.stringify({
    v: "ghostbroker.envelope/1",
    institutionId: us2InstitutionId,
    agentDid: us2AgentDid,
    authorityRef: us2AuthorityRef,
    assetCode,
    side,
    quantity,
    price,
    nonce: "nonce-test",
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: us2AuthorityRef,
      policyHash: "policy:us2",
      delegationCredential: request.delegationCredential,
    };
  }

  public async loadAndVerify(input: {
    agentId: string;
    agentDid: string;
    requestedAction: AgentDelegationVerificationRequest["requestedAction"];
  }): Promise<AgentDelegationVerificationResult> {
    return {
      status: "verified",
      agentDid: input.agentDid,
      authorityRef: us2AuthorityRef,
      policyHash: "policy:us2",
      delegationCredential: { id: `vc-${input.agentDid}` },
    };
  }
}

const SETTLEMENT_ASSET = "USDC";

interface EnvelopePayload {
  v: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

function decodeTestEnvelope(envelope: string): EnvelopePayload {
  const json = Buffer.from(envelope, "base64url").toString("utf8");
  const record = JSON.parse(json) as Record<string, unknown>;
  return {
    v: String(record["v"] ?? ""),
    assetCode: String(record["assetCode"] ?? ""),
    side: record["side"] === "buy" ? "buy" : "sell",
    quantity: Number(record["quantity"] ?? 0),
    price: Number(record["price"] ?? 0),
  };
}

class StaticBlindIntentClient implements BlindIntentClient {
  public counter = 0;
  public async sealIntent(
    request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    this.counter++;
    const payload = decodeTestEnvelope(request.encryptedIntentEnvelope);
    const assetCode =
      payload.side === "buy" ? SETTLEMENT_ASSET : payload.assetCode;
    const amount =
      payload.side === "buy"
        ? payload.quantity * payload.price
        : payload.quantity;
    return {
      intentHandle: `intent_opaque_${this.counter}`,
      state: "intent_sealed",
      executionRef: `t3exec_${this.counter}`,
      sealedAt: new Date().toISOString(),
      lockDescriptor: {
        tradedAssetCode: payload.assetCode.toUpperCase(),
        assetCode: assetCode.toUpperCase(),
        side: payload.side,
        amount,
        attestationRef: `t3attest:${this.counter}`,
      },
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
      matchedQuantity: 0,
      executionPrice: 0,
      buyerLockedAmount: 0,
      sellerLockedAmount: 0,
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
  agentRepository: AgentRepository = buildAgentRepositoryWithVc(),
): HiddenIntentService {
  return new HiddenIntentService(
    new VerifiedAuthorization(),
    new StaticBlindIntentClient(),
    new TelemetryBus(),
    orchestrator,
    agentRepository,
    portfolioService,
  );
}

/**
 * Build an `AgentRepository` that has the buyer and seller
 * agents pre-registered with a delegation VC in metadata. The
 * submit-time null check in `HiddenIntentService.submitIntent`
 * requires the VC to be loadable from the repository; without
 * this, the test would have to thread the VC through a
 * different seam.
 */
function buildAgentRepositoryWithVc(): AgentRepository {
  const repo = new FakeAgentRepository();
  return repo;
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

    await service.submitIntent(
      buildHiddenIntentRequest({
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 45000),
      }),
      { correlationRef: "corr_lock_buy_1" },
    );

    const portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings).toEqual([
      { assetCode: "USDC", balance: 10_000_000, locked: 4_500_000 },
    ]);
  });

  it("locks quantity of the asset on submitIntent for a sell intent", async () => {
    const sellerRequest = buildHiddenIntentRequestForSide("sell", {
      institutionId: sellerInstitutionId,
      encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 100, 43000),
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
      service.submitIntent(
        buildHiddenIntentRequest({
          encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 45000),
        }),
        { correlationRef: "corr_lock_overdraw" },
      ),
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

    const accepted = await service.submitIntent(
      buildHiddenIntentRequest({
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 45000),
      }),
      { correlationRef: "corr_lock_cancel" },
    );
    // Lock placed.
    let portfolio = await new PortfolioService(client as never, "USDC")
      .getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]?.locked).toBe(4_500_000);

    await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentId: us2AgentId,
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

    await service.submitIntent(
      buildHiddenIntentRequest({
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 45000),
      }),
      { correlationRef: "corr_lock_revoke" },
    );

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

    // First intent: 5 * 1000 = 5_000, well within the 1M available.
    await service.submitIntent(
      buildHiddenIntentRequest({
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 5, 1000),
      }),
      { correlationRef: "corr_lock_multi_1" },
    );
    await service.submitIntent(
      buildHiddenIntentRequest({
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 5, 1000),
      }),
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
    // the atomic persistence path must release exactly the matched
    // reservation amounts, while preserving any unrelated locks that
    // were already present on the same rows.

    // Build a settlement that uses the same PortfolioService the
    // orchestrator uses, so the SQL clamping runs end-to-end.
    const buyerId = us2InstitutionId;
    const sellerId = sellerInstitutionId;
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: buyerId,
        assetCode: "USDC",
        balance: 11_000_000,
        locked: 1_000_000,
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
        locked: 20,
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
        // Enclave-decided fill: 100 WBTC @ 50000 midpoint. The
        // orchestrator settles on these authoritative values.
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
          matchedQuantity: 100,
          executionPrice: 50000,
          // TEE-attested per-side lock release amounts.
          buyerLockedAmount: 5_000_000,
          sellerLockedAmount: 100,
        };
      }
    }

    class SettlingSettlement
      implements Pick<SettlementService, "executeSettlement">
    {
      constructor(private readonly settlementClient: InMemoryPortfolioClient) {}
      public async executeSettlement(): Promise<never> {
        // Mirrors what SettlementService now does in production:
        // `persist_completed_settlement` is the transactional
        // boundary for the completed trade + balance mutation.
        await this.settlementClient.rpc("persist_completed_settlement", {
          completed_trade: {
            trade_ref: "outcome_test",
            buy_institution_id: buyerId,
            sell_institution_id: sellerId,
          },
          receipts: [],
          settlement_plaintext: {
            buyer_institution_id: buyerId,
            seller_institution_id: sellerId,
            asset_code: "WBTC",
            quantity: 100,
            execution_price: 50000,
          },
        });
        throw new Error("test-only stub does not return a trade record");
      }
    }

    const orchestrator = new MatchingOrchestrator(
      new MatchedClient(),
      new SettlingSettlement(client) as unknown as SettlementService,
      new TelemetryBus(),
      portfolioService,
    );
    const service = buildHiddenIntentService(orchestrator, portfolioService);

    // Submit a buy intent (buyer locks 100 * 50000 = 5_000_000 USDC).
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 50000),
      }),
      { correlationRef: "corr_settle_buy" },
    );
    // Submit a matching sell intent (seller locks 100 WBTC).
    await service.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-settle-test",
        authorityRef: us2AuthorityRef,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 100, 50000),
      }),
      { correlationRef: "corr_settle_sell" },
    );

    // Both locks should be in place.
    let buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    expect(buyerPortfolio.holdings.find((h) => h.assetCode === "USDC")?.locked).toBe(6_000_000);
    let sellerPortfolio = await portfolioService.getPortfolio(sellerId);
    expect(sellerPortfolio.holdings.find((h) => h.assetCode === "WBTC")?.locked).toBe(120);

    // The orchestrator's matching attempt runs on the second submit.
    // We let it process: the matching loop is fire-and-forget after
    // submission, so we wait for it to settle.
    // The matching will call the atomic settlement RPC via
    // the stub above, then throw to short-circuit the rest
    // of the production settlement return path.
    await new Promise((r) => setTimeout(r, 50));

    // After settlement, the matched 5_000_000 USDC and 100 WBTC locks
    // are released, while the pre-existing 1_000_000 USDC and 20 WBTC
    // reservations remain intact.
    buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    const buyerCash = buyerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    expect(buyerCash).toEqual({
      assetCode: "USDC",
      balance: 6_000_000,
      locked: 1_000_000,
    });
    const buyerAsset = buyerPortfolio.holdings.find((h) => h.assetCode === "WBTC");
    expect(buyerAsset).toEqual({
      assetCode: "WBTC",
      balance: 100,
      locked: 0,
    });
    sellerPortfolio = await portfolioService.getPortfolio(sellerId);
    const sellerAsset = sellerPortfolio.holdings.find((h) => h.assetCode === "WBTC");
    expect(sellerAsset).toEqual({
      assetCode: "WBTC",
      balance: 900,
      locked: 20,
    });
    const sellerCash = sellerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    expect(sellerCash).toEqual({
      assetCode: "USDC",
      balance: 5_000_000,
      locked: 0,
    });
  });

  it("releases the counterparty's lock on a post-match balance failure (not just TTL)", async () => {
    // Regression test: before the lock-ref work, the four
    // defensive failure paths (balance, direction scope,
    // instrument scope, max notional) spliced the counterparty
    // from the queue but did NOT release its `portfolios.locked`
    // amount. The counterparty's lock would then be stranded
    // for up to 5 minutes until TTL eviction.
    //
    // These checks now run AFTER the enclave returns `matched`
    // (the enclave is match authority), so this stub returns
    // `matched` to reach the balance-check path.
    //
    // Setup:
    // - buyer has 10M USDC (enough to lock 5M)
    // - seller has 100 WBTC, locked = 0 at submit time
    //
    // On the seller's submit, the lock of 100 WBTC succeeds
    // (available = 100 - 0 = 100). After the lock, the
    // seller's available becomes 100 - 100 = 0.
    //
    // The orchestrator's matching loop evaluates the (buyer, seller)
    // pair via the enclave, which returns `matched`. The post-match
    // defensive checks then run against the enclave-decided fill.
    // The buyer's balance check passes (USDC available = 5M >= 5M
    // trade cost). The seller's balance check FAILS (WBTC available
    // = 0 < 100 match qty, because the seller's own submit-time lock
    // consumed its balance). The orchestrator splices the buyer
    // (the counterparty = `other` in the loop) from the queue AND
    // releases the buyer's lock.
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
    // Match authority lives in the enclave, so the defensive
    // balance check now runs AFTER the enclave returns `matched`.
    // This stub returns `matched` (qty 100 @ 50000) so the
    // balance check executes; the seller's available WBTC is 0
    // (consumed by its own submit-time lock), so the check fails
    // and the counterparty (buyer) is evicted with its lock
    // released.
    class MatchedForBalanceCheckClient implements MatchContractClient {
      public async evaluateMatch(
        _request: MatchEvaluationRequest,
      ): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: "outcome_balance_check",
          executionRef: "exec_balance_check",
          buyerInstitutionId: "",
          sellerInstitutionId: "",
          encryptedTradeFieldsRef: "fields_balance_check",
          buyerAuthorityRef: "",
          sellerAuthorityRef: "",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          matchedQuantity: 100,
          executionPrice: 50000,
          buyerLockedAmount: 5_000_000,
          sellerLockedAmount: 100,
        };
      }
    }
    const ps2 = new PortfolioService(clientWithLocks as never, "USDC");
    const orch2 = new MatchingOrchestrator(
      new MatchedForBalanceCheckClient(),
      new NoOpSettlement() as unknown as SettlementService,
      new TelemetryBus(),
      ps2,
    );
    const service2 = buildHiddenIntentService(orch2, ps2);

    // Buyer submits first, locks 5_000_000 USDC.
    await service2.submitIntent(
      buildHiddenIntentRequest({
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 100, 50000),
      }),
      { correlationRef: "corr_prematch_buyer" },
    );
    // Seller submits second, locks 100 WBTC.
    await service2.submitIntent(
      buildHiddenIntentRequest({
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-prematch",
        authorityRef: us2AuthorityRef,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 100, 50000),
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
