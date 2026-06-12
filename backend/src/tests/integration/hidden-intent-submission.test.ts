import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BlindIntentClient,
  BlindIntentRequest,
  BlindIntentResult,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
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
    };
  }
}

class StaticBlindIntentClient implements BlindIntentClient {
  public async sealIntent(
    request: BlindIntentRequest,
  ): Promise<BlindIntentResult> {
    expect(request.encryptedIntentEnvelope).toContain("ciphertext");
    return {
      intentHandle: "intent_opaque_us2",
      state: "intent_sealed",
      executionRef: "t3exec_us2",
      sealedAt: "2026-06-12T00:00:00.000Z",
    };
  }
}

describe("hidden intent submission", () => {
  it("returns only an opaque intent handle for authorized encrypted input", async () => {
    const service = new HiddenIntentService(
      new VerifiedAuthorization(),
      new StaticBlindIntentClient(),
      new TelemetryBus(),
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
});
