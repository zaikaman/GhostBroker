import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BlindIntentClient,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { PublicError } from "../../errors/public-error.js";
import { HiddenIntentService } from "../../services/hidden-intent.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
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
    );

    await expect(
      service.submitIntent(buildHiddenIntentRequest(), {
        correlationRef: "corr_rejected",
      }),
    ).rejects.toThrow(PublicError);
  });
});
