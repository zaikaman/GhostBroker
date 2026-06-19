import { verifyGhostbrokerDelegationCredential } from "./ghostbroker-delegation.js";
import type {
  GhostbrokerVerificationRequest,
  GhostbrokerVerificationResult,
  RequestedAgentAction,
} from "./ghostbroker-delegation.js";

/**
 * The single delegation verifier used by the GhostBroker backend.
 *
 * Ghostbroker-style W3C Verifiable Credential is the only credential
 * format supported end-to-end. The live T3N network today issues
 * exactly this shape (the Ghostbroker delegation BUIDL is the only published
 * live reference for "what Terminal 3 actually gives you"); the
 * JCS Smart VC shape is reserved for a future programmatic T3
 * issuer and is not part of the production code path.
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which the
 * run-loop persists and echoes back on every privileged action
 * (`submitIntent`, `cancelIntent`, `settlement.execute`).
 *
 * The verifier runs entirely from the in-memory VC. The legacy
 * live-network fallback (`POST /agent-delegations/verify`) was
 * removed in the post-Phase 1 rewrite: the Ghostbroker delegation
 * verifier is now a pure function over the persisted VC, so the
 * class no longer accepts or stores a `T3NetworkClient` or a
 * verification-path argument. The `authorityRef` on the request is
 * used to confirm the agent is presenting the same credential it
 * was admitted with (a stale VC is rejected as `over_scoped`).
 */

export type { RequestedAgentAction } from "./ghostbroker-delegation.js";

export interface AgentDelegationVerificationRequest {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  requestedAction: RequestedAgentAction;
  revokedAuthorityRefs?: ReadonlySet<string>;
  /** Ghostbroker delegation W3C VC persisted at admit time. */
  delegationCredential: unknown;
}

export type AgentDelegationRejectionReason =
  | "expired"
  | "revoked"
  | "over_scoped"
  | "unverified"
  | "agent_mismatch"
  | "malformed"
  | "demo_proof_in_live_mode";

export interface VerifiedAgentDelegation {
  status: "verified";
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

export interface RejectedAgentDelegation {
  status: "rejected";
  agentDid: string;
  reason: AgentDelegationRejectionReason;
}

export type AgentDelegationVerificationResult =
  | VerifiedAgentDelegation
  | RejectedAgentDelegation;

export interface AgentDelegationVerifier {
  verifyDelegation(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
}

/**
 * Ghostbroker-only agent authorization adapter. The verifier runs
 * entirely from the in-memory VC, with the VC's own `id` and
 * `issuer` driving `authorityRef` and `policyHash`. The legacy
 * `POST /agent-delegations/verify` live-network fallback has been
 * removed in the post-Phase 1 rewrite; this class is now a pure
 * function over the persisted credential.
 */
export class GhostbrokerDelegationAgentAuthClient
  implements AgentDelegationVerifier
{
  public async verifyDelegation(
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

    const result: GhostbrokerVerificationResult =
      await verifyGhostbrokerDelegationCredential(vcRequest);

    if (result.status !== "verified") {
      return {
        status: "rejected",
        agentDid: request.agentDid,
        reason: result.reason,
      };
    }

    // Confirm the agent is presenting the same VC it was admitted
    // with. A mismatch means the agent is reusing a session token
    // for a credential it no longer holds; reject it.
    if (request.authorityRef && result.authorityRef !== request.authorityRef) {
      return {
        status: "rejected",
        agentDid: request.agentDid,
        reason: "over_scoped",
      };
    }

    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef: result.authorityRef,
      policyHash: result.policyHash,
    };
  }
}
