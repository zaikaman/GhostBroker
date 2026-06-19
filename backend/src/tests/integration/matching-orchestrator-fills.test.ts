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
import {
  buildHiddenIntentRequestForSide,
} from "../data/us2-encrypted-intent-builders.js";
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

const SETTLEMENT_ASSET = "USDC";

/**
 * Decode the canonical `ghostbroker.envelope/1` envelope back
 * into its structured payload. The in-process test path uses
 * envelopes built by `buildSealedEnvelopePayload`; production
 * T3N responses include the lock descriptor on the wire so
 * the orchestrator does not need to decode anything.
 */
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
    // The TEE seal returns the lock descriptor alongside the
    // opaque handle. The in-process test path derives the
    // descriptor from the canonical envelope (mirroring the
    // production T3 fallback in
    // `T3BlindIntentClient.resolveLockDescriptor`); production
    // T3N responses include the descriptor on the wire and
    // skip this decode.
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

class MatchedClient implements MatchContractClient {
  public calls = 0;
  public async evaluateMatch(
    request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
    this.calls++;
    // Mirrors the real enclave's match-authoritative logic
    // (contracts/matching-policy/src/matching.rs v0.5.0+): the
    // TEE receives both sealed envelopes plus the TEE-attested
    // lock descriptor attestation refs and returns the
    // authoritative fill + per-side lock release amounts. The
    // orchestrator consumes the values verbatim -- it does not
    // re-derive them. The test stub here re-decodes both
    // envelopes to mirror the production TEE math: the matched
    // quantity is `min(buy_quantity, sell_quantity)`, the
    // execution price is the deterministic midpoint, and the
    // per-side lock release amounts follow the TEE's standard
    // reservation formula.
    const buyEnvelope = decodeTestEnvelope(request.buyEnvelope);
    const sellEnvelope = decodeTestEnvelope(request.sellEnvelope);
    const matchedQuantity = Math.min(
      buyEnvelope.quantity,
      sellEnvelope.quantity,
    );
    const executionPrice = Math.round(
      (buyEnvelope.price + sellEnvelope.price) / 2,
    );
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
      matchedQuantity,
      executionPrice,
      buyerLockedAmount: matchedQuantity * executionPrice,
      sellerLockedAmount: matchedQuantity,
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
      matchedQuantity: 0,
      executionPrice: 0,
      buyerLockedAmount: 0,
      sellerLockedAmount: 0,
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
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 10, 40000),
      }),
      { correlationRef: "corr_x_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-x",
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 10, 50000),
      }),
      { correlationRef: "corr_x_sell" },
    );
    await new Promise((r) => setTimeout(r, 30));

    // Match authority now lives in the enclave: the orchestrator
    // consults it for the candidate pair instead of short-circuiting
    // on a local crossing guard. The enclave returns no_match (the
    // bid does not cross the ask), so no settlement runs and both
    // intents stay pending.
    expect(matchClient.calls).toBeGreaterThanOrEqual(1);
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
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 10, 50000),
      }),
      { correlationRef: "corr_pf_buy" },
    );
    // Seller offers only 4 @ 50000 -> locks 4 WBTC. Match qty = 4.
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-pf",
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 4, 50000),
      }),
      { correlationRef: "corr_pf_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Match price = midpoint = 50000. Settlement moved 4 WBTC for
    // 200000 USDC (the TEE-attested buyer lock release).
    const buyerPortfolio = await portfolioService.getPortfolio(buyerId);
    const buyerCash = buyerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    // The TEE-attested buyer lock release is 4 * 50000 = 200000
    // USDC. The buyer paid 4 * 50000 = 200000, and the matched
    // lock portion of 200000 was released, leaving the residual
    // 6 * 50000 = 300000 still locked.
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

    // The buyer's intent stays queued; the seller's intent is gone.
    expect(orchestrator.pendingCount()).toBe(1);

    // The durable lock ref for the buyer is unchanged (the
    // orchestrator does not mutate the TEE-attested amount on
    // partial fill -- the SQL `portfolios.locked` column is the
    // source of truth for free balance). The seller's ref was
    // deleted on full fill.
    const buyerLockRow = lockClient.rows.find(
      (r) => r.intent_handle === buyAccepted.intentHandle,
    );
    expect(buyerLockRow?.amount).toBe("500000");
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
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        agentDid: "did:t3n:agent:buyer-cred",
        authorityRef: "authority:buyer-cred",
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 4, 50000),
      }),
      { correlationRef: "corr_cred_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-cred",
        authorityRef: "authority:seller-cred",
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 4, 50000),
      }),
      { correlationRef: "corr_cred_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    expect(settlement.requests[0]?.buyerDelegationCredential).toEqual(buyerCredential);
    expect(settlement.requests[0]?.sellerDelegationCredential).toEqual(sellerCredential);
  });

  it("uses the enclave-decided matched_quantity and execution_price, not local calculations", async () => {
    // Match authority lives in the enclave. The orchestrator must
    // settle on the enclave's matched_quantity / execution_price
    // verbatim, even when those values differ from a local min() /
    // midpoint() would have produced. We return fill terms that no
    // local formula could derive and assert they flow through to
    // settlement unchanged.
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);

    // Local formulas would give qty=min(10,10)=10 and
    // price=midpoint(50000,50000)=50000. The enclave returns
    // different authoritative values; the orchestrator must honour
    // them.
    const ENCLAVE_QUANTITY = 7;
    const ENCLAVE_PRICE = 48000;
    class AuthoritativeClient implements MatchContractClient {
      public async evaluateMatch(
        _request: MatchEvaluationRequest,
      ): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: "outcome_authoritative",
          executionRef: "exec_authoritative",
          buyerInstitutionId: "",
          sellerInstitutionId: "",
          encryptedTradeFieldsRef: "fields_authoritative",
          buyerAuthorityRef: "",
          sellerAuthorityRef: "",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          matchedQuantity: ENCLAVE_QUANTITY,
          executionPrice: ENCLAVE_PRICE,
          buyerLockedAmount: ENCLAVE_QUANTITY * ENCLAVE_PRICE,
          sellerLockedAmount: ENCLAVE_QUANTITY,
        };
      }
    }
    const matchClient = new AuthoritativeClient();
    const { service } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
    );

    await service.submitIntent(
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope("WBTC", "buy", 10, 50000),
      }),
      { correlationRef: "corr_auth_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-auth",
        encryptedIntentEnvelope: makeEnvelope("WBTC", "sell", 10, 50000),
      }),
      { correlationRef: "corr_auth_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    const request = settlement.requests[0];
    expect(request?.quantity).toBe(ENCLAVE_QUANTITY);
    expect(request?.executionPrice).toBe(ENCLAVE_PRICE);
  });
});

function makeEnvelope(
  assetCode: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
): string {
  const json = JSON.stringify({
    v: "ghostbroker.envelope/1",
    institutionId: buyerId,
    agentDid: "did:t3n:agent:buyer-default",
    authorityRef: "auth-default",
    assetCode,
    side,
    quantity,
    price,
    nonce: "nonce-test",
  });
  return Buffer.from(json, "utf8").toString("base64url");
}
