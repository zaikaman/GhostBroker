import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BlindIntentClient,
  BlindIntentRequest,
  BlindIntentResult,
} from "../../enclave/index.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";
import {
  buildHiddenIntentRequest,
  us2AuthorityRef,
} from "../data/us2-encrypted-intent-builders.js";

class VerifiedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    expect(request.requestedAction).toBe("intent.submit");
    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: us2AuthorityRef,
      policyHash: "policy:us2",
      delegationCredential: request.delegationCredential,
    };
  }

  public async loadAndVerify(input: {
    institutionId: string;
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

class StaticBlindIntentClient implements BlindIntentClient {
  public counter = 0;
  public async sealIntent(
    request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    expect(request.encryptedIntentEnvelope).toContain("ciphertext");
    return {
      intentHandle: "intent_opaque_us2",
      state: "intent_sealed",
      executionRef: "t3exec_us2",
      sealedAt: "2026-06-12T00:00:00.000Z",
      lockDescriptor: {
        tradedAssetCode: "WBTC",
        assetCode: "USDC",
        side: "buy",
        amount: 4_500_000,
        attestationRef: "t3attest:us2",
      },
    };
  }
}

describe("hidden intent submission", () => {
  it("returns only an opaque intent handle for authorized encrypted input", async () => {
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      new TelemetryBus(),
      undefined,
      new FakeAgentRepository(),
    );

    await expect(
      service.submitIntent(buildHiddenIntentRequest(), {
        correlationRef: "corr_us2",
      }),
    ).resolves.toEqual({
      intentHandle: "intent_opaque_us2",
      state: "intent_sealed",
    });
  });

  it("rejects the submit with authorization_failed when the agent's persisted VC cannot be loaded", async () => {
    // Reproduces the production hole where `agentRepository.findById`
    // returns null (Supabase transient error, agent record missing,
    // or `metadata.delegation_credential` not populated). The
    // submit-time check in `HiddenIntentService.submitIntent` runs
    // through `loadAndVerify`, which fails closed on a missing
    // persisted VC — refuses the intent rather than queueing it
    // with a null credential. A queued intent with null VC would
    // die at the next match and the operator would have no way
    // to recover the locked balance short of TTL eviction.
    const repository = new FakeAgentRepository();
    repository.disableAutoRegister();
    const failingAuthz: AgentAuthorizationFacade = {
      verifyAgentAuthority: () => Promise.reject(new Error("not used")),
      loadAndVerify: () =>
        Promise.resolve({
          status: "rejected",
          agentDid: "did:t3n:0xmissing",
          reason: "revoked",
        }),
    };
    const service = new HiddenIntentService(
      failingAuthz,
      new StaticBlindIntentClient(),
      new TelemetryBus(),
      undefined,
      repository,
    );
    await expect(
      service.submitIntent(buildHiddenIntentRequest(), {
        correlationRef: "corr_no_vc",
      }),
    ).rejects.toMatchObject({ code: "authorization_failed" });
  });
});
