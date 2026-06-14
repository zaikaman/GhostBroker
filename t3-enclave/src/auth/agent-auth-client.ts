import type { T3NetworkClient } from "../sandbox/t3n-client.js";
import { verifyBoundbuyerDelegationCredential } from "./boundbuyer-delegation.js";
import type {
  BoundbuyerVerificationRequest,
  BoundbuyerVerificationResult,
  RequestedAgentAction,
} from "./boundbuyer-delegation.js";

/**
 * The single delegation verifier used by the GhostBroker backend.
 *
 * Boundbuyer-style W3C Verifiable Credential is the only credential
 * format supported end-to-end. The live T3N network today issues
 * exactly this shape (the boundbuyer BUIDL is the only published
 * live reference for "what Terminal 3 actually gives you"); the
 * JCS Smart VC shape is reserved for a future programmatic T3
 * issuer and is not part of the production code path.
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which the
 * run-loop persists and echoes back on every privileged action
 * (`submitIntent`, `cancelIntent`, `settlement.execute`).
 */

export type { RequestedAgentAction } from "./boundbuyer-delegation.js";

export interface AgentDelegationVerificationRequest {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  requestedAction: RequestedAgentAction;
  revokedAuthorityRefs?: ReadonlySet<string>;
  /** Boundbuyer W3C VC persisted at admit time. */
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
 * Boundbuyer-only agent authorization adapter. The live-network
 * fallback (POST /agent-delegations/verify) is gone — the boundbuyer
 * verifier runs entirely from the in-memory VC, with the VC's own
 * `id` and `issuer` driving `authorityRef` and `policyHash`.
 *
 * `authorityRef` on the request is used to confirm the agent is
 * presenting the same credential it was admitted with (a stale VC
 * is rejected as `over_scoped`).
 *
 * The constructor still takes a `T3NetworkClient` for compatibility
 * with the composition root in the backend's `app.ts`. The
 * boundbuyer verifier does not need to make any network calls, so
 * the argument is captured but not used. Tests wire a stub client
 * to satisfy the type.
 */
export class DashboardDelegationAgentAuthClient
  implements AgentDelegationVerifier
{
  public constructor(
    // Retained for compatibility with the composition root in
    // the backend's `app.ts`. The boundbuyer verifier runs from
    // the in-memory VC and does not need network access, so
    // these are captured but not used.
    _client?: T3NetworkClient,
    _verificationPath = "/agent-delegations/verify",
  ) {
    // Intentionally empty — see class doc.
  }

  public async verifyDelegation(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    const vcRequest: BoundbuyerVerificationRequest = {
      credential: request.delegationCredential,
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      requestedAction: request.requestedAction,
      ...(request.revokedAuthorityRefs !== undefined
        ? { revokedAuthorityRefs: request.revokedAuthorityRefs }
        : {}),
    };

    const result: BoundbuyerVerificationResult =
      await verifyBoundbuyerDelegationCredential(vcRequest);

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
