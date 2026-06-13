import type {
  BlindIntentClient,
  AgentDelegationVerificationRequest,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import { PublicError } from "../errors/public-error.js";
import type {
  HiddenIntentAccepted,
  HiddenIntentRequest,
} from "../models/hidden-intent.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { MatchingOrchestrator } from "./matching-orchestrator.js";
import {
  EmptyAuthorityRevocationRepository,
  type AuthorityRevocationRepository,
} from "./authority-revocation.service.js";

export interface HiddenIntentSubmissionContext {
  correlationRef: string;
}

export interface HiddenIntentSubmissionService {
  submitIntent(
    request: HiddenIntentRequest,
    context: HiddenIntentSubmissionContext,
  ): Promise<HiddenIntentAccepted>;
}

export class HiddenIntentService implements HiddenIntentSubmissionService {
  private readonly authorization: AgentAuthorizationFacade;
  private readonly blindIntentClient: BlindIntentClient;
  private readonly telemetryBus: TelemetryBus;
  private readonly revocations: AuthorityRevocationRepository;
  private readonly matchingOrchestrator: MatchingOrchestrator | undefined;

  public constructor(
    authorization: AgentAuthorizationFacade,
    blindIntentClient: BlindIntentClient,
    telemetryBus: TelemetryBus,
    revocations: AuthorityRevocationRepository = new EmptyAuthorityRevocationRepository(),
    matchingOrchestrator?: MatchingOrchestrator,
  ) {
    this.authorization = authorization;
    this.blindIntentClient = blindIntentClient;
    this.telemetryBus = telemetryBus;
    this.revocations = revocations;
    this.matchingOrchestrator = matchingOrchestrator;
  }

  public async submitIntent(
    request: HiddenIntentRequest,
    context: HiddenIntentSubmissionContext,
  ): Promise<HiddenIntentAccepted> {
    this.publish(request, context.correlationRef, "intent_received");
    await this.assertAuthority(request);

    const sealed = await this.blindIntentClient.sealIntent({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      encryptedIntentEnvelope: request.encryptedIntentEnvelope,
      authorityRef: request.authorityRef,
      correlationRef: context.correlationRef,
    });

    this.publish(request, context.correlationRef, "intent_sealed");
    this.publish(request, sealed.intentHandle, "encrypted_evaluation");

    // Trigger matching against pending intents (fire-and-forget)
    if (this.matchingOrchestrator) {
      this.matchingOrchestrator.onIntentSealed({
        correlationRef: context.correlationRef,
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        intentHandle: sealed.intentHandle,
        executionRef: sealed.executionRef,
        encryptedEnvelope: request.encryptedIntentEnvelope,
        authorityRef: request.authorityRef,
        assetCode: request.settlementMetadata.assetCode,
        side: request.settlementMetadata.side,
        quantity: request.settlementMetadata.quantity,
        price: request.settlementMetadata.price,
        sealedAt: sealed.sealedAt,
      }).catch((error: unknown) => {
        // Matching/settlement failures are non-blocking — intent is already sealed
        console.error(
          `[MatchingOrchestrator] Match error for ${context.correlationRef}:`,
          error,
        );
      });
    }

    return {
      intentHandle: sealed.intentHandle,
      state: "intent_sealed",
    };
  }

  private async assertAuthority(request: HiddenIntentRequest): Promise<void> {
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );
    const verificationRequest: AgentDelegationVerificationRequest = {
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityProof: request.authorityRef,
      requestedAction: "intent.submit",
      revokedAuthorityRefs,
    };
    const verification =
      await this.authorization.verifyAgentAuthority(verificationRequest);

    if (
      verification.status !== "verified" ||
      verification.authorityRef !== request.authorityRef
    ) {
      throw new PublicError("authorization_failed", 403);
    }
  }

  private publish(
    request: HiddenIntentRequest,
    correlationRef: string,
    phase: "intent_received" | "intent_sealed" | "encrypted_evaluation",
  ): void {
    this.telemetryBus.publish({
      institutionId: request.institutionId,
      type: "telemetry.processing.changed",
      phase,
      severity: "info",
      correlationRef,
      agentId: request.agentDid,
    });
  }
}
