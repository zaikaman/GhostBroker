import { verifyGhostbrokerDelegationCredential } from "./ghostbroker-delegation.js";
import type {
  GhostbrokerVerificationRequest,
  GhostbrokerVerificationResult,
  RequestedAgentAction,
} from "./ghostbroker-delegation.js";

/**
 * Single production agent authorization adapter.
 *
 * Ghostbroker-style W3C Verifiable Credentials are the only
 * credential format the live T3N onboarding surface mints. The
 * live JCS Smart-VC prove flow is no longer supported; the
 * dashboard (and, in the post-Phase 1 architecture, the
 * backend's own `tenant-delegation.ts` signer) is the canonical
 * issuer of every delegation VC the system accepts.
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which the
 * run-loop persists and echoes back on every privileged action
 * (`submitIntent`, `cancelIntent`, `settlement.execute`,
 * `negotiation.*`).
 *
 * The verifier is a **pure in-memory function** over the
 * persisted VC. It does NOT call any `T3NetworkClient` and does
 * NOT call a live `POST /agent-delegations/verify` endpoint:
 * the earlier live-network fallback was removed in the
 * post-Phase 1 rewrite because the GhostBroker verifier in
 * `ghostbroker-delegation.ts` is the single source of truth,
 * and the live-network surface for programmatic delegation
 * remains undocumented in the Terminal 3 public docs. The
 * `T3AgentIdentityVerifier` (a separate, non-authoritative
 * DID-challenge check used only for the dashboard login flow)
 * is the only place a T3 network call is made at the auth
 * boundary, and that call is best-effort, not a primary
 * authority gate.
 *
 * Production behaviour:
 *
 *   - `verifyGhostbrokerDelegationCredential` runs the W3C VC
 *     shape + time-window + DID-binding + revocation checks,
 *     and (in `live` mode) the `EcdsaSecp256k1Signature2019`
 *     crypto verification via `@terminal3/verify_vc`.
 *   - In `live` and `structural` modes, the verifier fails
 *     closed on any SDK error — it never silently downgrades
 *     to a non-cryptographic pass. In `sandbox` mode the
 *     historical "verified on SDK error" semantic is kept for
 *     the demo surface.
 *   - The request's `authorityRef` is compared against the
 *     verifier's `authorityRef`. A mismatch is the
 *     `over_scoped` rejection: the agent is presenting a
 *     different VC than the one it was admitted with, which
 *     is the load-bearing check that detects a session
 *     reuse against a stale credential.
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
  /**
   * Additional Ethereum addresses the verifier should accept
   * as a valid signer of `delegationCredential`, in addition
   * to the address derived from `delegationCredential.issuer`.
   *
   * The production signer uses the institution's T3 SDK API
   * key as its `privateKey`. The T3 SDK authenticates with
   * the API key's derived address and the server returns a
   * `did:t3n:0x<addr>` whose embedded address does NOT match
   * the API key's derived address. The signature still has
   * to be cryptographically valid — `recoveredAddress` must
   * equal the API key's derived address — but the verifier
   * cannot derive that address from the issuer DID alone.
   * Callers that own the API key pass its derived address
   * here.
   */
  additionalTrustedSignerAddresses?: ReadonlySet<string>;
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
  /**
   * The Ghostbroker delegation W3C VC the facade verified. Carried
   * on the result so the orchestrator can snapshot it onto the
   * in-flight session / intent and re-verify the same credential at
   * settlement time. Without this, the orchestrator has no way to
   * pin the VC that was authorized at open time and a later
   * "Regenerate Delegation" re-mint (or a Supabase transient error
   * in the snapshot path) would let settlement re-verify against
   * the wrong credential.
   */
  delegationCredential: unknown;
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
 * Single concrete production adapter. The historical second
 * implementation, the `POST /agent-delegations/verify`
 * live-network fallback, was removed in the post-Phase 1
 * rewrite — see the file-level docstring. The structural
 * `AgentDelegationVerifier` interface above is retained for
 * the runner dependency-injection seam in
 * `t3-enclave/src/runner/agent-loop.ts`; it is not a contract
 * the project promises to satisfy with more than one
 * implementation.
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
      ...(request.additionalTrustedSignerAddresses !== undefined
        ? {
            additionalTrustedSignerAddresses:
              request.additionalTrustedSignerAddresses,
          }
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
      delegationCredential: request.delegationCredential,
    };
  }
}
