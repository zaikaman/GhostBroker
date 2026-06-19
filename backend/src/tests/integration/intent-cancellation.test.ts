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
import { PublicError } from "../../errors/public-error.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { SettlementService } from "../../services/settlement.service.js";
import {
  buildHiddenIntentRequest,
  us2AgentDid,
  us2AuthorityRef,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public verifyCount = 0;
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    this.verifyCount++;
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
    _request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    this.counter++;
    return {
      intentHandle: `intent_opaque_${this.counter}`,
      state: "intent_sealed",
      executionRef: `t3exec_${this.counter}`,
      sealedAt: new Date().toISOString(),
      lockDescriptor: {
        tradedAssetCode: "WBTC",
        assetCode: "USDC",
        side: "buy",
        amount: 4_500_000,
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

class RecordingSettlement implements Pick<SettlementService, "executeSettlement"> {
  public calls: unknown[] = [];
  public async executeSettlement(...args: unknown[]): Promise<never> {
    this.calls.push(args);
    throw new Error("Settlement not configured for cancel test");
  }
}

class FailingAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(): Promise<AgentDelegationVerificationResult> {
    return {
      status: "rejected",
      agentDid: us2AgentDid,
      reason: "unverified",
    };
  }
}

describe("intent cancellation", () => {
  it("removes a pending intent from the orchestrator and returns the cancellation receipt", async () => {
    const telemetry = new TelemetryBus();
    const settlement = new RecordingSettlement();
    const matchClient = new NoOpMatchClient();
    const orchestrator = new MatchingOrchestrator(
      matchClient,
      settlement as unknown as SettlementService,
      telemetry,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      undefined,
      orchestrator,
    );

    const accepted = await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_cancel_1",
    });
    expect(accepted.state).toBe("intent_sealed");
    expect(orchestrator.pendingCount()).toBe(1);

    const result = await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentDid: us2AgentDid,
      intentHandle: accepted.intentHandle,
      authorityRef: us2AuthorityRef,
    });

    expect(result).toEqual({
      intentHandle: accepted.intentHandle,
      state: "intent_cancelled",
    });
    expect(orchestrator.pendingCount()).toBe(0);
  });

  it("emits a telemetry event on cancel with phase intent_cancelled", async () => {
    const telemetry = new TelemetryBus();
    const received: { phase: string; severity: string }[] = [];
    telemetry.subscribe((event) => {
      received.push({
        phase: event.phase,
        severity: event.severity,
      });
    });

    const settlement = new RecordingSettlement();
    const matchClient = new NoOpMatchClient();
    const orchestrator = new MatchingOrchestrator(
      matchClient,
      settlement as unknown as SettlementService,
      telemetry,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      undefined,
      orchestrator,
    );

    const accepted = await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_cancel_2",
    });
    await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentDid: us2AgentDid,
      intentHandle: accepted.intentHandle,
      authorityRef: us2AuthorityRef,
    });

    const cancelEvent = received.find((e) => e.phase === "intent_cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.severity).toBe("warning");
  });

  it("returns null when cancelling an unknown handle", async () => {
    const telemetry = new TelemetryBus();
    const settlement = new RecordingSettlement();
    const matchClient = new NoOpMatchClient();
    const orchestrator = new MatchingOrchestrator(
      matchClient,
      settlement as unknown as SettlementService,
      telemetry,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      undefined,
      orchestrator,
    );

    const result = await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentDid: us2AgentDid,
      intentHandle: "intent_does_not_exist",
      authorityRef: us2AuthorityRef,
    });

    expect(result).toBeNull();
  });

  it("rejects cancellation with a mismatched agentDid", async () => {
    const telemetry = new TelemetryBus();
    const settlement = new RecordingSettlement();
    const matchClient = new NoOpMatchClient();
    const orchestrator = new MatchingOrchestrator(
      matchClient,
      settlement as unknown as SettlementService,
      telemetry,
    );
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      undefined,
      orchestrator,
    );

    const accepted = await service.submitIntent(buildHiddenIntentRequest(), {
      correlationRef: "corr_cancel_3",
    });
    const result = await service.cancelIntent({
      institutionId: us2InstitutionId,
      agentDid: "did:t3n:agent:different-agent",
      intentHandle: accepted.intentHandle,
      authorityRef: us2AuthorityRef,
    });

    // Ownership check fails — orchestrator returns undefined.
    expect(result).toBeNull();
    // The intent is still in the queue.
    expect(orchestrator.pendingCount()).toBe(1);
  });

  it("rejects cancellation when authority proof fails verification", async () => {
    const telemetry = new TelemetryBus();
    const settlement = new RecordingSettlement();
    const matchClient = new NoOpMatchClient();
    const orchestrator = new MatchingOrchestrator(
      matchClient,
      settlement as unknown as SettlementService,
      telemetry,
    );
    const service = new HiddenIntentService(
      new FailingAuthorization(),
      new StaticBlindIntentClient(),
      telemetry,
      undefined,
      orchestrator,
    );

    await expect(
      service.cancelIntent({
        institutionId: us2InstitutionId,
        agentDid: us2AgentDid,
        intentHandle: "intent_anything",
        authorityRef: us2AuthorityRef,
      }),
    ).rejects.toBeInstanceOf(PublicError);
  });
});
