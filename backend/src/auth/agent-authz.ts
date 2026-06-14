import { verifyGhostbrokerDelegationCredential } from "@ghostbroker/t3-enclave";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  GhostbrokerVerificationRequest,
} from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";

/**
 * Single Ghostbroker delegation-only authorization facade.
 *
 * Every privileged backend action — `AgentService.admitAgent`,
 * `HiddenIntentService.submitIntent`, `HiddenIntentService.cancelIntent`,
 * and `SettlementCommandBuilder.build` — re-verifies the agent's
 * W3C VC (the credential persisted at admit time) before allowing
 * the action. The Ghostbroker-style W3C Verifiable Credential is
 * the only credential format the live T3N onboarding surface
 * mints; the JCS Smart-VC prove flow is no longer supported.
 */
export interface AgentAuthorizationFacade {
  verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
}

export class T3AgentAuthorizationFacade implements AgentAuthorizationFacade {
  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    const vcRequest: GhostbrokerVerificationRequest = {
      credential: request.delegationCredential,
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      requestedAction: request.requestedAction,
      ...(request.revokedAuthorityRefs !== undefined
        ? { revokedAuthorityRefs: request.revokedAuthorityRefs }
        : {}),
    };

    const result = await verifyGhostbrokerDelegationCredential(vcRequest);

    if (result.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    if (
      request.authorityRef &&
      result.authorityRef !== request.authorityRef
    ) {
      throw new PublicError("authorization_failed", 403);
    }

    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: result.authorityRef,
      policyHash: result.policyHash,
    };
  }
}
