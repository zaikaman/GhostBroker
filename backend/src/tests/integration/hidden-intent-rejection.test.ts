import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BlindIntentClient,
} from "../../enclave/index.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { PublicError } from "../../errors/public-error.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";
import { buildHiddenIntentRequest } from "../data/us2-encrypted-intent-builders.js";

class RejectedAuthorization implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return {
      status: "rejected",
      agentDid: request.agentDid,
      reason: "over_scoped",
    };
  }

  public async loadAndVerify(): Promise<AgentDelegationVerificationResult> {
    throw new PublicError("authorization_failed", 403);
  }
}

describe("hidden intent rejection", () => {
  it("rejects over-scoped intent submissions without blinding", async () => {
    const blindIntentClient: BlindIntentClient = {
      sealIntent: async () => {
        throw new Error("over-scoped intent should not be sealed");
      },
    };
    const service = new HiddenIntentService(
      new RejectedAuthorization(),
      blindIntentClient,
      new TelemetryBus(),
      undefined,
      undefined,
      new FakeAgentRepository(),
    );

    await expect(
      service.submitIntent(buildHiddenIntentRequest(), {
        correlationRef: "corr_rejected",
      }),
    ).rejects.toThrow(PublicError);
  });
});
