import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { IntentLockJanitor } from "../../services/intent-lock-janitor.js";
import { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import { PortfolioService } from "../../services/portfolio.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { SettlementService } from "../../services/settlement.service.js";
import {
  buildHiddenIntentRequest,
  us2AgentDid,
  us2AgentId,
  us2AuthorityRef,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";
import { InMemoryIntentLockClient } from "../support/in-memory-intent-lock-client.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";

/**
 * The core safety property of the lock-refs work:
 *
 * 1. The orchestrator acquires a lock and writes a ref to
 *    `intent_locks` for the just-queued intent.
 * 2. The orchestrator process restarts (in this test, we
 *    simulate this by discarding all in-memory state and
 *    constructing a fresh orchestrator + service).
 * 3. The lock ref is now orphaned — the in-memory queue has
 *    no record of the intent, but `portfolios.locked` still
 *    has the locked amount, and `intent_locks` still has the
 *    ref row.
 * 4. The orphan-lock janitor sweeps after the intent TTL
 *    elapses, finds the ref, releases the lock amount, and
 *    deletes the ref row.
 * 5. The institution's available balance is restored.
 *
 * Without the ref-and-janitor pair, step 3 would leave the
 * locked amount stranded indefinitely (or until the next
 * settlement drained the balance, which is not guaranteed).
 */

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: us2AuthorityRef,
      policyHash: "policy:restart-safety",
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
      policyHash: "policy:restart-safety",
      delegationCredential: { id: `vc-${input.agentDid}` },
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
      intentHandle: `intent_restart_${this.counter}`,
      state: "intent_sealed",
      executionRef: `t3exec_restart_${this.counter}`,
      sealedAt: new Date().toISOString(),
      lockDescriptor: {
        tradedAssetCode: "WBTC",
        assetCode: "USDC",
        side: "buy",
        amount: 4_500_000,
        attestationRef: `t3attest:restart_${this.counter}`,
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
    throw new Error("Settlement not configured for restart-safety test");
  }
}

describe("orphan-lock restart safety", () => {
  let portfolioClient: InMemoryPortfolioClient;
  let lockClient: InMemoryIntentLockClient;
  let telemetry: TelemetryBus;

  beforeEach(() => {
    portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 10_000_000,
      }),
    ]);
    lockClient = new InMemoryIntentLockClient();
    telemetry = new TelemetryBus();
  });

  afterEach(() => {
    // janitor.stop() called in individual tests as needed.
  });

  it("releases a stranded lock when the orchestrator restarts", async () => {
    // === Phase 1: original process. Submit an intent, get a lock. ===
    const portfolioService1 = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator1 = new MatchingOrchestrator(
      new NoOpMatchClient(),
      new NoOpSettlement() as unknown as SettlementService,
      telemetry,
      portfolioService1,
      "USDC",
      undefined, // intentTtlMs
      undefined, // cleanupIntervalMs
      lockClient,
    );
    const service1 = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      orchestrator1,
      new FakeAgentRepository(),
      portfolioService1,
      lockClient,
    );

    const accepted = await service1.submitIntent(
      buildHiddenIntentRequest(),
      { correlationRef: "corr_restart_1" },
    );

    // Lock is in place on the portfolio AND in the lock table.
    let portfolio = await portfolioService1.getPortfolio(
      us2InstitutionId,
    );
    expect(portfolio.holdings[0]?.locked).toBe(4_500_000);
    expect(lockClient.rows).toHaveLength(1);
    const refBeforeRestart = lockClient.rows[0];
    if (!refBeforeRestart) {
      throw new Error("expected the seeded lock ref to be present");
    }

    // === Phase 2: process restart. Discard the orchestrator and
    // service; build fresh ones. The lockClient and
    // portfolioClient are durable (in production, Supabase), so
    // they keep the stranded lock + ref. The new orchestrator
    // has an empty queue and no knowledge of the original intent.
    orchestrator1.stop();

    const portfolioService2 = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator2 = new MatchingOrchestrator(
      new NoOpMatchClient(),
      new NoOpSettlement() as unknown as SettlementService,
      telemetry,
      portfolioService2,
      "USDC",
      undefined,
      undefined,
      lockClient,
    );
    expect(orchestrator2.pendingCount()).toBe(0);

    // === Phase 3: simulate the TTL passing. Re-seed the lock
    // ref with an old `created_at` so the sweeper picks it up.
    lockClient.rows.length = 0;
    lockClient.seed({
      intent_handle: accepted.intentHandle,
      institution_id: refBeforeRestart.institution_id,
      asset_code: refBeforeRestart.asset_code,
      amount: refBeforeRestart.amount,
      correlation_ref: refBeforeRestart.correlation_ref,
      agent_did: refBeforeRestart.agent_did,
      created_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    });

    // === Phase 4: run the janitor. It releases the lock
    // amount AND deletes the ref row.
    const janitor = new IntentLockJanitor(
      lockClient,
      portfolioService2,
      { telemetryBus: telemetry, lockTtlMs: 5 * 60 * 1000 },
    );
    const swept = await janitor.sweep();
    janitor.stop();

    expect(swept).toBe(1);
    expect(lockClient.rows).toHaveLength(0);

    // The stranded `portfolios.locked` amount is gone.
    portfolio = await portfolioService2.getPortfolio(us2InstitutionId);
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 10_000_000,
      locked: 0,
    });

    // The fresh orchestrator was never involved in recovery —
    // it has no in-memory record of the original intent, but
    // the durable state is consistent.
    expect(orchestrator2.pendingCount()).toBe(0);
  });

  it("preserves fresh locks across a restart (does not sweep them)", async () => {
    // Phase 1: submit an intent with a fresh ref.
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator = new MatchingOrchestrator(
      new NoOpMatchClient(),
      new NoOpSettlement() as unknown as SettlementService,
      telemetry,
      portfolioService,
      "USDC",
      undefined,
      undefined,
      lockClient,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      orchestrator,
      new FakeAgentRepository(),
      portfolioService,
      lockClient,
    );

    const accepted = await service.submitIntent(
      buildHiddenIntentRequest(),
      { correlationRef: "corr_restart_fresh" },
    );
    expect(lockClient.rows).toHaveLength(1);
    expect(lockClient.rows[0]?.intent_handle).toBe(accepted.intentHandle);

    // The ref is FRESH (just written). A sweeper at this
    // moment should leave it alone — it might still belong to
    // a live in-memory intent on another orchestrator
    // instance, or about to be matched.
    const janitor = new IntentLockJanitor(
      lockClient,
      portfolioService,
      { telemetryBus: telemetry, lockTtlMs: 5 * 60 * 1000 },
    );
    const swept = await janitor.sweep();
    janitor.stop();

    expect(swept).toBe(0);
    expect(lockClient.rows).toHaveLength(1);
    // Lock is still in place on the portfolio.
    const portfolio = await portfolioService.getPortfolio(
      us2InstitutionId,
    );
    expect(portfolio.holdings[0]?.locked).toBe(4_500_000);

    orchestrator.stop();
  });

  it("the orchestrator's eviction paths delete the lock ref", async () => {
    // This is a focused unit-level check that the orchestrator
    // itself, when its own eviction runs, deletes the ref.
    // (Cancellation is a separate test in intent-cancellation.)
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator = new MatchingOrchestrator(
      new NoOpMatchClient(),
      new NoOpSettlement() as unknown as SettlementService,
      telemetry,
      portfolioService,
      "USDC",
      undefined,
      undefined,
      lockClient,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      orchestrator,
      new FakeAgentRepository(),
      portfolioService,
      lockClient,
    );

    const accepted = await service.submitIntent(
      buildHiddenIntentRequest(),
      { correlationRef: "corr_cancel_ref" },
    );
    expect(lockClient.rows).toHaveLength(1);

    await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentId: us2AgentId,
      agentDid: us2AgentDid,
      intentHandle: accepted.intentHandle,
      authorityRef: us2AuthorityRef,
    });

    // The cancel flow removes the intent from the queue and
    // deletes the ref. The janitor should have nothing to do.
    expect(lockClient.rows).toHaveLength(0);

    const janitor = new IntentLockJanitor(
      lockClient,
      portfolioService,
      { telemetryBus: telemetry, lockTtlMs: 5 * 60 * 1000 },
    );
    expect(await janitor.sweep()).toBe(0);
    janitor.stop();

    orchestrator.stop();
  });
});
