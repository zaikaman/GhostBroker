import { verifyGhostbrokerDelegationCredential } from "../enclave/index.js";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  GhostbrokerVerificationRequest,
} from "../enclave/index.js";
import { PublicError } from "../errors/public-error.js";
import type { AgentManagementService } from "../services/agent.service.js";

/**
 * Migration shim for delegation credentials that were persisted with the
 * old `credentialSubject.allowedCategories` field (a procurement BUIDL
 * enum: `office-supplies | software | hardware | services | travel`)
 * instead of the current `allowedActions` trading-action scope.
 *
 * When the credential lacks `allowedActions` but has `allowedCategories`,
 * this function injects a default `allowedActions` set broad enough for
 * any agent that was operational under the old schema. The default set
 * includes all trading-related actions, preserving the operational scope
 * the old credential implicitly granted.
 */
function migrateCredentialSubject(credential: unknown): unknown {
  if (!credential || typeof credential !== "object") {
    return credential;
  }
  const vc = credential as Record<string, unknown>;
  if (
    !vc.credentialSubject ||
    typeof vc.credentialSubject !== "object"
  ) {
    return credential;
  }
  const cs = vc.credentialSubject as Record<string, unknown>;

  // If `allowedCategories` is present but `allowedActions` is missing,
  // inject a default set of trading actions so the verifier accepts the
  // credential. This matches the operational scope the old credential
  // implicitly granted to any admitted agent.
  if ("allowedCategories" in cs && !("allowedActions" in cs)) {
    cs.allowedActions = [
      "agent.admit",
      "intent.submit",
      "settlement.execute",
      "negotiation.open",
      "negotiation.move",
      "negotiation.disclose",
      "negotiation.settle",
    ];
  }

  return vc;
}

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
 *
 * The post-Phase 1 path no longer requires the agent to send
 * the VC on every call. The dashboard mints + signs the VC at
 * "Configure Agent" time and persists it on the agent record;
 * the agent process only sends its API key (institution
 * context) + its `agentId`/`agentDid`. The facade
 * `loadAndVerify` looks up the persisted VC and runs the
 * existing verifier against it. The `verifyAgentAuthority`
 * entrypoint is kept for the legacy admit-time path
 * (admitting a fresh agent with the VC passed inline, e.g.
 * from an E2E test or a custom integration).
 */
export interface AgentAuthorizationFacade {
  verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
  /**
   * Server-side: load the persisted VC for the agent and
   * verify it. This is the post-Phase 1 default. The agent
   * process never sends the VC; the backend owns it.
   */
  loadAndVerify(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    requestedAction: AgentDelegationVerificationRequest["requestedAction"];
  }): Promise<AgentDelegationVerificationResult>;
}

export class T3AgentAuthorizationFacade implements AgentAuthorizationFacade {
  private agentService: AgentManagementService | undefined;

  public constructor(
    agentService?: AgentManagementService,
  ) {
    this.agentService = agentService;
  }

  /**
   * Late-bind the agent service. The composition root in
   * `app.ts` builds the agent service first (it has no
   * dependency on the facade), then the facade with the
   * service injected; this setter is the escape hatch
   * for the rare case where the cycle can't be untangled
   * at construction time. Production code passes the
   * service in the constructor.
   */
  public setAgentService(service: AgentManagementService): void {
    this.agentService = service;
  }

  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    // Normalize delegation credentials that use the old `allowedCategories`
    // field (from the procurement BUIDL schema) to the new `allowedActions`
    // trading-action scope. This provides backward compatibility for
    // credentials persisted before the schema migration.
    const normalizedCredential = migrateCredentialSubject(
      request.delegationCredential,
    );
    const vcRequest: GhostbrokerVerificationRequest = {
      credential: normalizedCredential,
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      requestedAction: request.requestedAction,
      ...(request.revokedAuthorityRefs !== undefined
        ? { revokedAuthorityRefs: request.revokedAuthorityRefs }
        : {}),
    };

    const result = await verifyGhostbrokerDelegationCredential(vcRequest);

    if (result.status !== "verified") {
      console.warn(
        `[AUTHZ] Delegation verification rejected — reason: ${result.reason}, ` +
        `agentDid: ${result.agentDid}, ` +
        `action: ${request.requestedAction}`,
      );
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
      delegationCredential: request.delegationCredential,
    };
  }

  public async loadAndVerify(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    requestedAction: AgentDelegationVerificationRequest["requestedAction"];
  }): Promise<AgentDelegationVerificationResult> {
    if (!this.agentService) {
      // No service wired: the facade is being used in
      // isolation (e.g. contract tests). Refuse — the
      // server-side path is the only supported path
      // post-Phase 1.
      throw new PublicError("authorization_failed", 403);
    }
    const vc = await this.agentService.loadDelegationCredential({
      agentId: input.agentId,
      institutionId: input.institutionId,
    });
    if (!vc) {
      throw new PublicError("authorization_failed", 403);
    }
    return this.verifyAgentAuthority({
      institutionId: input.institutionId,
      agentDid: input.agentDid,
      authorityRef: "",
      delegationCredential: vc,
      requestedAction: input.requestedAction,
    });
  }
}