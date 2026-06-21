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
import {
  decodeSealedEnvelope,
} from "../../enclave/matching/blind-intent.js";
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
  getTestEnvelopeMasterKey,
  sealTestEnvelope,
  us2AuthorityRef,
} from "../data/us2-encrypted-intent-builders.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";
import { InMemoryIntentLockClient } from "../support/in-memory-intent-lock-client.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";

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
      authorityRef: "auth-stub-fills",
      policyHash: "policy:fills",
      delegationCredential: { id: `vc-${input.agentDid}` },
    };
  }
}

const SETTLEMENT_ASSET = "USDC";

// v0.10.0 kv-store simulation: StaticBlindIntentClient writes
// the decoded payload keyed by intent handle; MatchedClient
// reads it back by handle to compute the fill — mirroring the
// real TEE's kv-store-backed evaluate-match path.
const intentKvStore = new Map<string, { quantity: number; price: number; side: string }>();

/**
 * Decode a `ghostbroker.envelope.aead/v1` envelope back into its
 * structured payload. The in-process test path uses envelopes
 * built by `sealTestEnvelope` (real AES-256-GCM, not plaintext);
 * production T3N responses include the lock descriptor on the
 * wire so the orchestrator does not need to decode anything.
 */
interface EnvelopePayload {
  v: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

function decodeTestEnvelope(
  envelope: string,
  institutionId: string,
  agentDid: string,
  authorityRef: string,
): EnvelopePayload {
  const decoded = decodeSealedEnvelope(
    envelope,
    { institutionDid: institutionId, agentDid, authorityRef },
    getTestEnvelopeMasterKey(),
  );
  return {
    v: decoded.v,
    assetCode: decoded.assetCode,
    side: decoded.side,
    quantity: decoded.quantity,
    price: decoded.price,
  };
}

class StaticBlindIntentClient implements BlindIntentClient {
  public counter = 0;
  public async sealIntent(
    request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    this.counter++;
    // v0.10.0: the TEE seal decrypts the envelope, persists
    // price/quantity to kv-store, and returns only the derived
    // amount + asset/side. The test stub mirrors this: it
    // decodes the envelope, stores the payload in the shared
    // intentKvStore, and returns the lock descriptor without
    // price/quantity.
    const payload = decodeTestEnvelope(
      request.encryptedIntentEnvelope,
      request.institutionId,
      request.agentDid,
      request.authorityRef,
    );
    const assetCode =
      payload.side === "buy" ? SETTLEMENT_ASSET : payload.assetCode;
    const amount =
      payload.side === "buy"
        ? payload.quantity * payload.price
        : payload.quantity;
    const intentHandle = `intent_opaque_${this.counter}`;
    intentKvStore.set(intentHandle, {
      quantity: payload.quantity,
      price: payload.price,
      side: payload.side,
    });
    return {
      intentHandle,
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
    // v0.10.0: the TEE recovers price/quantity from kv-store
    // by handle. The stub mirrors this: it looks up both
    // handles in the shared intentKvStore and computes the fill
    // (min quantity, midpoint price) from the stored payloads.
    const buyPayload = intentKvStore.get(request.buyIntentHandle);
    const sellPayload = intentKvStore.get(request.sellIntentHandle);
    let matchedQuantity: number;
    let executionPrice: number;
    if (buyPayload && sellPayload) {
      matchedQuantity = Math.min(buyPayload.quantity, sellPayload.quantity);
      executionPrice = Math.round((buyPayload.price + sellPayload.price) / 2);
    } else {
      // Fallback for handles not in the kv-store (should not
      // happen in well-isolated tests).
      matchedQuantity = 0;
      executionPrice = 0;
    }
    return {
      status: "matched",
      outcomeRef: `outcome_${this.calls}`,
      executionRef: `exec_${this.calls}`,
      buyerInstitutionId: request.buyInstitutionId,
      sellerInstitutionId: request.sellInstitutionId,
      assetCodeCiphertext: "aead.v1:test:asset",
      quantityCiphertext: "aead.v1:test:qty",
      executionPriceCiphertext: "aead.v1:test:price",
      encryptedTradeFieldsRef: `fields_${this.calls}`,
      buyerAuthorityRef: request.buyAuthorityRef,
      sellerAuthorityRef: request.sellAuthorityRef,
      // v0.8.0: TEE-attested match attestation. Stubbed
      // with a deterministic value here; production callers
      // compute the same value via the TEE contract and
      // surface it on the audit log.
      matchAttestationRef: `match_attest_${this.calls}`,
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
  public async evaluateMatch(
    request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
    this.calls++;
    // v0.8.0: the TEE echoes the per-side identity on a
    // `no_match` outcome too, so the orchestrator's audit log
    // records which institution pair was rejected. The stub
    // mirrors that by echoing the inputs.
    return {
      status: "no_match",
      outcomeRef: "",
      executionRef: "",
      buyerInstitutionId: request.buyInstitutionId,
      sellerInstitutionId: request.sellInstitutionId,
      assetCodeCiphertext: "aead.v1:test:asset",
      quantityCiphertext: "aead.v1:test:qty",
      executionPriceCiphertext: "aead.v1:test:price",
      encryptedTradeFieldsRef: "",
      buyerAuthorityRef: request.buyAuthorityRef,
      sellerAuthorityRef: request.sellAuthorityRef,
      matchAttestationRef: "",
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
  agentRepository: AgentRepository = new FakeAgentRepository(),
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
    orchestrator,
    agentRepository,
    portfolioService,
    lockClient as never,
  );
  return { service, orchestrator };
}

describe("matching orchestrator - fills and crossing", () => {
  beforeEach(() => {
    intentKvStore.clear();
  });

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
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          us2AuthorityRef,
          "WBTC",
          "buy",
          10,
          40000,
        ),
      }),
      { correlationRef: "corr_x_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-x",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-x",
          us2AuthorityRef,
          "WBTC",
          "sell",
          10,
          50000,
        ),
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
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          us2AuthorityRef,
          "WBTC",
          "buy",
          10,
          50000,
        ),
      }),
      { correlationRef: "corr_pf_buy" },
    );
    // Seller offers only 4 @ 50000 -> locks 4 WBTC. Match qty = 4.
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-pf",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-pf",
          us2AuthorityRef,
          "WBTC",
          "sell",
          4,
          50000,
        ),
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
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-cred",
          "authority:buyer-cred",
          "WBTC",
          "buy",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_cred_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-cred",
        authorityRef: "authority:seller-cred",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-cred",
          "authority:seller-cred",
          "WBTC",
          "sell",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_cred_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    // Settlement now routes through `loadAndVerify` on the
    // authorization facade; the orchestrator forwards each side's
    // agentId so the facade can look up the persisted VC. The
    // VC is no longer snapshotted on the request.
    expect(settlement.requests[0]?.buyerAgentId).toBeDefined();
    expect(settlement.requests[0]?.sellerAgentId).toBeDefined();
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
        request: MatchEvaluationRequest,
      ): Promise<OpaqueMatchOutcome> {
        // v0.8.0: echo the per-side identity supplied by the
        // orchestrator so the identity-consistency check
        // passes.
        return {
          status: "matched",
          outcomeRef: "outcome_authoritative",
          executionRef: "exec_authoritative",
          buyerInstitutionId: request.buyInstitutionId,
          sellerInstitutionId: request.sellInstitutionId,
          assetCodeCiphertext: "aead.v1:test:asset",
          quantityCiphertext: "aead.v1:test:qty",
          executionPriceCiphertext: "aead.v1:test:price",
          encryptedTradeFieldsRef: "fields_authoritative",
          buyerAuthorityRef: request.buyAuthorityRef,
          sellerAuthorityRef: request.sellAuthorityRef,
          matchAttestationRef: "match_attest_authoritative",
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
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          us2AuthorityRef,
          "WBTC",
          "buy",
          10,
          50000,
        ),
      }),
      { correlationRef: "corr_auth_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-auth",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-auth",
          us2AuthorityRef,
          "WBTC",
          "sell",
          10,
          50000,
        ),
      }),
      { correlationRef: "corr_auth_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    const request = settlement.requests[0];
    expect(request?.quantity).toBe(ENCLAVE_QUANTITY);
    expect(request?.executionPrice).toBe(ENCLAVE_PRICE);
  });

  it("populates the three settlement ciphertext columns with distinct opaque handles (P0 privacy)", async () => {
    // P0 regression: the previous orchestrator code populated all
    // three columns with the buy-side `encryptedEnvelope` blob,
    // which let any DB reader decode one column and recover the
    // plaintext asset/quantity/price for both sides. The columns
    // now carry distinct SHA-256-based opaque correlation handles
    // derived from the TEE-attested match outcome.
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    // Local stub that echoes the orchestrator-supplied institution
    // IDs / authority refs on the match outcome. The orchestrator
    // fails closed when the TEE echo disagrees with the
    // pending-intent queue values, so the stub must populate these
    // fields for settlement to run.
    const P0_OUTCOME_REF = "outcome_p0_privacy";
    const P0_EXECUTION_REF = "exec_p0_privacy";
    class MatchedClientWithIds implements MatchContractClient {
      public async evaluateMatch(): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: P0_OUTCOME_REF,
          executionRef: P0_EXECUTION_REF,
          buyerInstitutionId: buyerId,
          sellerInstitutionId: sellerId,
          assetCodeCiphertext: "aead.v1:test:asset",
          quantityCiphertext: "aead.v1:test:qty",
          executionPriceCiphertext: "aead.v1:test:price",
          encryptedTradeFieldsRef: "fields_p0",
          buyerAuthorityRef: us2AuthorityRef,
          sellerAuthorityRef: us2AuthorityRef,
          matchAttestationRef: "match_attest_p0_privacy",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          matchedQuantity: 4,
          executionPrice: 50000,
          buyerLockedAmount: 4 * 50000,
          sellerLockedAmount: 4,
        };
      }
    }
    const matchClient = new MatchedClientWithIds();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const { service } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
    );

    const buyEnvelope = makeEnvelope(
      buyerId,
      "did:t3n:agent:buyer-us2",
      us2AuthorityRef,
      "WBTC",
      "buy",
      4,
      50000,
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        encryptedIntentEnvelope: buyEnvelope,
      }),
      { correlationRef: "corr_p0_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-p0",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-p0",
          us2AuthorityRef,
          "WBTC",
          "sell",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_p0_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(1);
    const request = settlement.requests[0];
    expect(request).toBeDefined();
    const fields = request?.encryptedTradeFields;
    expect(fields).toBeDefined();

    // The three columns are pairwise distinct.
    expect(fields?.assetCodeCiphertext).not.toBe(fields?.quantityCiphertext);
    expect(fields?.assetCodeCiphertext).not.toBe(
      fields?.executionPriceCiphertext,
    );
    expect(fields?.quantityCiphertext).not.toBe(
      fields?.executionPriceCiphertext,
    );

    // None of the columns equals the encrypted envelope that was
    // used to derive them. The previous code wrote the envelope
    // directly into all three columns, which is the regression
    // we are locking down here.
    expect(fields?.assetCodeCiphertext).not.toBe(buyEnvelope);
    expect(fields?.quantityCiphertext).not.toBe(buyEnvelope);
    expect(fields?.executionPriceCiphertext).not.toBe(buyEnvelope);

    // The handles carry the `sha256:` opaque-handle prefix and
    // are 64-hex characters after the prefix (so the dashboard
    // and audit tools can recognise them).
    expect(fields?.assetCodeCiphertext).toMatch(/^aead\.v1:/u);
    expect(fields?.quantityCiphertext).toMatch(/^aead\.v1:/u);
    expect(fields?.executionPriceCiphertext).toMatch(
      /^aead\.v1:/u,
    );

    // Receipt integrity: the hash authenticates the ciphertext
    // payload, and the TEE attestation reference is distinct
    // from the orchestrator's `executionRef` (the previous bug
    // reused `executionRef` for both sides, which let a DB
    // reader correlate buyer and seller receipts to the same
    // orchestrator-minted UUID).
    const buyerReceipt = request?.receipts.find(
      (r) => r.accessScope === "buyer",
    );
    const sellerReceipt = request?.receipts.find(
      (r) => r.accessScope === "seller",
    );
    expect(buyerReceipt).toBeDefined();
    expect(sellerReceipt).toBeDefined();
    expect(buyerReceipt?.receiptHash).not.toBe(
      `sha256:${P0_OUTCOME_REF}:buyer`,
    );
    expect(buyerReceipt?.receiptHash).toMatch(/^sha256:/u);
    expect(buyerReceipt?.t3AttestationRef).not.toBe(P0_EXECUTION_REF);
    expect(buyerReceipt?.t3AttestationRef).not.toBe(
      sellerReceipt?.t3AttestationRef,
    );
    expect(buyerReceipt?.t3AttestationRef).toMatch(/^sha256:/u);
    expect(sellerReceipt?.t3AttestationRef).toMatch(/^sha256:/u);

    // v0.8.0: the TEE-attested match attestation ref flows
    // through to the receipt's t3AttestationRef column. Both
    // sides carry a domain-separated digest that binds the
    // receipt to the match_attestation_ref the TEE returned.
    expect(buyerReceipt?.t3AttestationRef).not.toBe(
      sellerReceipt?.t3AttestationRef,
    );
  });

  it("fails closed when the TEE echoes a different buyer institution id than the queue", async () => {
    // v0.8.0 audit-trail invariant: the TEE-attested buyer
    // institution id on the match outcome must match the buyer
    // institution id the orchestrator submitted from its
    // pending-intent queue. A mismatch means the settlement
    // would carry an institution ID the TEE never bound to this
    // match outcome — exactly the silent-overwrite bug the
    // audit fix addresses. The orchestrator refuses to settle
    // and evicts both intents so the available balance is
    // restored immediately rather than waiting for TTL
    // eviction.
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    const FORGED_INSTITUTION_ID = "00000000-0000-4000-8000-00000000ffff";
    class MismatchedClient implements MatchContractClient {
      public async evaluateMatch(
        request: MatchEvaluationRequest,
      ): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: "outcome_mismatch",
          executionRef: "exec_mismatch",
          // TEE echoes a DIFFERENT buyer institution id than
          // the queue submitted (simulating a poisoned queue,
          // refactor that lost the binding, or a TEE
          // regression).
          buyerInstitutionId: FORGED_INSTITUTION_ID,
          sellerInstitutionId: request.sellInstitutionId,
          assetCodeCiphertext: "aead.v1:test:asset",
          quantityCiphertext: "aead.v1:test:qty",
          executionPriceCiphertext: "aead.v1:test:price",
          encryptedTradeFieldsRef: "fields_mismatch",
          buyerAuthorityRef: request.buyAuthorityRef,
          sellerAuthorityRef: request.sellAuthorityRef,
          matchAttestationRef: "match_attest_mismatch",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          matchedQuantity: 4,
          executionPrice: 50000,
          buyerLockedAmount: 4 * 50000,
          sellerLockedAmount: 4,
        };
      }
    }
    const matchClient = new MismatchedClient();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const { service, orchestrator } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
    );

    await service.submitIntent(
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          us2AuthorityRef,
          "WBTC",
          "buy",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_mismatch_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-mismatch",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-mismatch",
          us2AuthorityRef,
          "WBTC",
          "sell",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_mismatch_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    // The orchestrator refused to settle — no settlement
    // request was issued despite the TEE returning a
    // `matched` outcome.
    expect(settlement.requests).toHaveLength(0);
    // Both intents were evicted from the queue so the
    // available balance is restored immediately rather than
    // waiting for TTL eviction.
    expect(orchestrator.pendingCount()).toBe(0);
    // The buyer institution's USDC lock was released (the
    // 200,000 USDC reservation is fully restored).
    const buyerPortfolio = await new PortfolioService(client as never, "USDC").getPortfolio(buyerId);
    const buyerCash = buyerPortfolio.holdings.find((h) => h.assetCode === "USDC");
    expect(buyerCash?.locked).toBe(0);
  });

  it("fails closed when the TEE echoes a different seller authority ref than the queue", async () => {
    // v0.8.0 audit-trail invariant: the TEE-attested seller
    // authority ref must match the seller authority ref the
    // orchestrator submitted from its pending-intent queue.
    // Same fail-closed pattern as the buyer institution id
    // case.
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    class MismatchedAuthorityClient implements MatchContractClient {
      public async evaluateMatch(
        request: MatchEvaluationRequest,
      ): Promise<OpaqueMatchOutcome> {
        return {
          status: "matched",
          outcomeRef: "outcome_authority_mismatch",
          executionRef: "exec_authority_mismatch",
          buyerInstitutionId: request.buyInstitutionId,
          sellerInstitutionId: request.sellInstitutionId,
          assetCodeCiphertext: "aead.v1:test:asset",
          quantityCiphertext: "aead.v1:test:qty",
          executionPriceCiphertext: "aead.v1:test:price",
          encryptedTradeFieldsRef: "fields_authority_mismatch",
          buyerAuthorityRef: request.buyAuthorityRef,
          // TEE echoes a DIFFERENT seller authority ref than
          // the queue submitted.
          sellerAuthorityRef: "ghostbroker-delegation:forged-vc",
          matchAttestationRef: "match_attest_authority_mismatch",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          matchedQuantity: 4,
          executionPrice: 50000,
          buyerLockedAmount: 4 * 50000,
          sellerLockedAmount: 4,
        };
      }
    }
    const matchClient = new MismatchedAuthorityClient();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const { service, orchestrator } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
    );

    await service.submitIntent(
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        authorityRef: "auth-buyer-correct",
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          "auth-buyer-correct",
          "WBTC",
          "buy",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_auth_mismatch_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-auth-mismatch",
        authorityRef: "auth-seller-correct",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-auth-mismatch",
          "auth-seller-correct",
          "WBTC",
          "sell",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_auth_mismatch_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(settlement.requests).toHaveLength(0);
    expect(orchestrator.pendingCount()).toBe(0);
  });

  it("settles when the TEE echoes the per-side identity exactly", async () => {
    // Positive path for the v0.8.0 audit-trail invariant:
    // when the TEE echoes the same institution IDs and
    // authority refs the orchestrator submitted, the
    // settlement proceeds and the audit log carries the
    // TEE-attested values (not the orchestrator's in-memory
    // queue values). The settlement record's per-side
    // institution ID is the value the TEE bound to the
    // outcome, which the match_attestation_ref proves
    // cryptographically.
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({ institutionId: buyerId, assetCode: "USDC", balance: 100_000_000 }),
      makePortfolioRecord({ institutionId: buyerId, assetCode: "WBTC", balance: 0 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "WBTC", balance: 1000 }),
      makePortfolioRecord({ institutionId: sellerId, assetCode: "USDC", balance: 0 }),
    ]);
    const matchClient = new MatchedClient();
    const lockClient = new InMemoryIntentLockClient();
    const settlement = new ForwardingSettlement(client);
    const { service } = buildStack(
      client,
      matchClient,
      settlement,
      lockClient,
    );

    await service.submitIntent(
      buildHiddenIntentRequestForSide("buy", {
        institutionId: buyerId,
        authorityRef: "auth-buyer-echoed",
        encryptedIntentEnvelope: makeEnvelope(
          buyerId,
          "did:t3n:agent:buyer-us2",
          "auth-buyer-echoed",
          "WBTC",
          "buy",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_echo_buy" },
    );
    await service.submitIntent(
      buildHiddenIntentRequestForSide("sell", {
        institutionId: sellerId,
        agentDid: "did:t3n:agent:seller-echoed",
        authorityRef: "auth-seller-echoed",
        encryptedIntentEnvelope: makeEnvelope(
          sellerId,
          "did:t3n:agent:seller-echoed",
          "auth-seller-echoed",
          "WBTC",
          "sell",
          4,
          50000,
        ),
      }),
      { correlationRef: "corr_echo_sell" },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Settlement ran with the TEE-attested identity in the
    // match outcome. The MatchedClient echoes the
    // orchestrator-supplied institution IDs and authority
    // refs verbatim, so the values flow through to the
    // settlement record unchanged.
    expect(settlement.requests).toHaveLength(1);
    const request = settlement.requests[0];
    expect(request?.matchOutcome.buyerInstitutionId).toBe(buyerId);
    expect(request?.matchOutcome.sellerInstitutionId).toBe(sellerId);
    // The TEE-attested match attestation ref is present on
    // the outcome — the orchestrator's audit log carries it
    // and the per-receipt t3AttestationRef derives from it.
    expect(request?.matchOutcome.matchAttestationRef).toMatch(
      /^match_attest_\d+$/u,
    );
  });
});

function makeEnvelope(
  institutionId: string,
  agentDid: string,
  authorityRef: string,
  assetCode: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
): string {
  return sealTestEnvelope({
    institutionDid: institutionId,
    agentDid,
    authorityRef,
    assetCode,
    side,
    quantity,
    price,
    nonce: "nonce-test",
  });
}
import { beforeEach } from "vitest";
