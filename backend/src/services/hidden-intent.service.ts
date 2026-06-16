import type {
  BlindIntentClient,
  AgentDelegationVerificationRequest,
} from "@ghostbroker/t3-enclave";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import { PublicError } from "../errors/public-error.js";
import type {
  CancelIntentRequest,
  HiddenIntentAccepted,
  HiddenIntentRequest,
  IntentCancelled,
  PendingIntent,
} from "../models/hidden-intent.js";
import type { TelemetryBus } from "./telemetry-bus.js";
import type { MatchingOrchestrator } from "./matching-orchestrator.js";
import {
  EmptyAuthorityRevocationRepository,
  type AuthorityRevocationRepository,
} from "./authority-revocation.service.js";
import type { AgentRepository } from "./agent-repository.js";
import {
  InsufficientBalanceError,
  type PortfolioService,
} from "./portfolio.service.js";
import type { IntentLockRepository } from "./intent-lock-repository.js";

export interface HiddenIntentSubmissionContext {
  correlationRef: string;
}

export interface HiddenIntentSubmissionService {
  submitIntent(
    request: HiddenIntentRequest,
    context: HiddenIntentSubmissionContext,
  ): Promise<HiddenIntentAccepted>;
  /**
   * Cancel a previously submitted intent that is still pending in the
   * matching orchestrator. Returns `null` if no matching intent was
   * found (already matched, expired, never existed, or owned by a
   * different agent).
   */
  cancelIntent(request: CancelIntentRequest): Promise<IntentCancelled | null>;
  /**
   * List currently-pending intents for the institution, optionally
   * filtered to a single agent. Reads the in-memory queue; never
   * throws on an empty queue.
   */
  listPendingIntents(params: {
    institutionId: string;
    agentDid?: string;
  }): readonly PendingIntent[];
}

export class HiddenIntentService implements HiddenIntentSubmissionService {
  private readonly authorization: AgentAuthorizationFacade;
  private readonly blindIntentClient: BlindIntentClient;
  private readonly telemetryBus: TelemetryBus;
  private readonly revocations: AuthorityRevocationRepository;
  private readonly matchingOrchestrator: MatchingOrchestrator | undefined;
  private readonly agentRepository: AgentRepository | undefined;
  private readonly portfolioService: PortfolioService | undefined;
  private readonly intentLockRepository: IntentLockRepository | undefined;

  public constructor(
    authorization: AgentAuthorizationFacade,
    blindIntentClient: BlindIntentClient,
    telemetryBus: TelemetryBus,
    revocations: AuthorityRevocationRepository = new EmptyAuthorityRevocationRepository(),
    matchingOrchestrator?: MatchingOrchestrator,
    agentRepository?: AgentRepository,
    portfolioService?: PortfolioService,
    intentLockRepository?: IntentLockRepository,
  ) {
    this.authorization = authorization;
    this.blindIntentClient = blindIntentClient;
    this.telemetryBus = telemetryBus;
    this.revocations = revocations;
    this.matchingOrchestrator = matchingOrchestrator;
    this.agentRepository = agentRepository;
    this.portfolioService = portfolioService;
    this.intentLockRepository = intentLockRepository;
  }

  public async submitIntent(
    request: HiddenIntentRequest,
    context: HiddenIntentSubmissionContext,
  ): Promise<HiddenIntentAccepted> {
    this.publish(request, context.correlationRef, "intent_received");
    const delegationCredential = await this.loadDelegationCredential(
      request.institutionId,
      request.agentDid,
    );
    await this.assertAuthority(request, delegationCredential);

    const sealed = await this.blindIntentClient.sealIntent({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      encryptedIntentEnvelope: request.encryptedIntentEnvelope,
      authorityRef: request.authorityRef,
      correlationRef: context.correlationRef,
    });

    this.publish(request, context.correlationRef, "intent_sealed");
    this.publish(request, sealed.intentHandle, "encrypted_evaluation");

    // Look up agent limits for pre-match authorization enforcement
    let instrumentScope: string[] | undefined;
    let directionScope: string[] | undefined;
    let maxNotional: string | undefined;

    if (this.agentRepository) {
      try {
        const agent = await this.agentRepository.findByAgentDid(
          request.institutionId,
          request.agentDid,
        );
        if (agent) {
          instrumentScope = agent.instrumentScope ?? undefined;
          directionScope = agent.directionScope ?? undefined;
          maxNotional = agent.maxNotional ?? undefined;
        }
      } catch {
        // Agent lookup failure is non-blocking â€” matching proceeds without limit checks
      }
    }

    // Acquire the balance reservation BEFORE pushing to the
    // orchestrator. This is the gate that prevents an agent
    // from over-committing their institution's available
    // balance across multiple intents.
    //
    // The lock amount is computed via the orchestrator's
    // `lockDescriptorFor` so the descriptor formula lives in one
    // place. If the orchestrator is not configured, the lock is
    // skipped (matching still runs and `checkBalance` enforces
    // a coarse check at the orchestrator level).
    if (this.portfolioService && this.matchingOrchestrator) {
      const syntheticIntent: PendingIntent = {
        correlationRef: context.correlationRef,
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        intentHandle: sealed.intentHandle,
        executionRef: sealed.executionRef,
        encryptedEnvelope: request.encryptedIntentEnvelope,
        authorityRef: request.authorityRef,
        delegationCredential: delegationCredential ?? null,
        assetCode: request.settlementMetadata.assetCode,
        side: request.settlementMetadata.side,
        quantity: request.settlementMetadata.quantity,
        price: request.settlementMetadata.price,
        sealedAt: sealed.sealedAt,
      };
      const reservation =
        this.matchingOrchestrator.lockDescriptorFor(syntheticIntent);

      try {
        await this.portfolioService.lockBalance(
          reservation.institutionId,
          reservation.assetCode,
          reservation.amount,
        );
      } catch (error) {
        if (error instanceof InsufficientBalanceError) {
          this.telemetryBus.publish({
            institutionId: reservation.institutionId,
            type: "telemetry.error.changed",
            phase: "authorization_failed",
            severity: "error",
            correlationRef: context.correlationRef,
            agentId: request.agentDid,
          });
          // Re-throw so the route returns 403 to the agent. The
          // TEE seal has already been consumed, but the agent
          // gets a clear error and no intent is queued.
          throw error;
        }
        // Transient DB / network error â€” log but allow the
        // submit to proceed. The orchestrator's `checkBalance`
        // and the settlement service will re-validate balances
        // before any money moves. (See infra-gaps.md Gap 7
        // for the trade-off discussion.)
        console.error(
          `[HiddenIntentService] Lock failed for ${context.correlationRef}:`,
          error,
        );
      }

      // Persist a reference to the lock so the orphan-lock
      // janitor can recover from process restarts. The ref
      // is keyed by the TEE-assigned intent handle, which is
      // also what the in-memory orchestrator uses for its
      // queue, so a successful delete on cancel/expire/match
      // always matches the live intent 1:1.
      //
      // Failure to write the ref is non-blocking: the lock
      // amount is still in `portfolios.locked`, and a manual
      // `portfolio_release_balance` call (e.g., from a future
      // reconciliation job) can still find and release it via
      // the `portfolios.locked` column. We do not roll back
      // the lock because the agent's intent is now in flight.
      if (this.intentLockRepository) {
        try {
          await this.intentLockRepository.create({
            intentHandle: sealed.intentHandle,
            institutionId: reservation.institutionId,
            assetCode: reservation.assetCode,
            amount: reservation.amount,
            correlationRef: context.correlationRef,
            agentDid: request.agentDid,
          });
        } catch (error) {
          console.error(
            `[HiddenIntentService] Failed to persist lock ref for ${sealed.intentHandle}:`,
            error,
          );
        }
      }
    }

    // Trigger matching against pending intents (fire-and-forget)
    if (this.matchingOrchestrator) {
      const pendingIntent: {
        correlationRef: string;
        institutionId: string;
        agentDid: string;
        intentHandle: string;
        executionRef: string;
        encryptedEnvelope: string;
        authorityRef: string;
        delegationCredential: unknown;
        assetCode: string;
        side: "buy" | "sell";
        quantity: number;
        price: number;
        sealedAt: string;
        instrumentScope?: string[];
        directionScope?: string[];
        maxNotional?: string;
      } = {
        correlationRef: context.correlationRef,
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        intentHandle: sealed.intentHandle,
        executionRef: sealed.executionRef,
        encryptedEnvelope: request.encryptedIntentEnvelope,
        authorityRef: request.authorityRef,
        delegationCredential: delegationCredential ?? null,
        assetCode: request.settlementMetadata.assetCode,
        side: request.settlementMetadata.side,
        quantity: request.settlementMetadata.quantity,
        price: request.settlementMetadata.price,
        sealedAt: sealed.sealedAt,
      };

      if (instrumentScope) {
        pendingIntent.instrumentScope = instrumentScope;
      }
      if (directionScope) {
        pendingIntent.directionScope = directionScope;
      }
      if (maxNotional) {
        pendingIntent.maxNotional = maxNotional;
      }

      this.matchingOrchestrator.onIntentSealed(
        pendingIntent as Parameters<typeof this.matchingOrchestrator.onIntentSealed>[0],
      ).catch((error: unknown) => {
        // Matching/settlement failures are non-blocking â€” intent is already sealed
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

  private async assertAuthority(
    request: HiddenIntentRequest,
    delegationCredential: unknown,
  ): Promise<void> {
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );

    // Re-verify the Ghostbroker delegation VC the agent was admitted with.
    // The VC is persisted in the agent record's metadata at admit
    // time (see `AgentService.admitAgent` and
    // `SupabaseAgentRepository.create`). Without this, the intent
    // submit path would try to JCS-parse the opaque `authorityRef`
    // string and reject the agent on every submit.
    const verificationRequest: AgentDelegationVerificationRequest = {
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef: request.authorityRef,
      delegationCredential,
      requestedAction: "intent.submit",
      revokedAuthorityRefs,
    };
    const verification =
      await this.authorization.verifyAgentAuthority(verificationRequest);

    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }
  }

  /**
   * Look up the Ghostbroker delegation VC persisted at admit time. Returns
   * `null` if the agent record is missing or has no credential â€”
   * the verifier will then reject as `unverified` / `malformed`.
   */
  private async loadDelegationCredential(
    institutionId: string,
    agentDid: string,
  ): Promise<unknown> {
    if (!this.agentRepository) {
      return null;
    }
    try {
      const agent = await this.agentRepository.findByAgentDid(
        institutionId,
        agentDid,
      );
      if (!agent) {
        return null;
      }
      const credential = (
        agent.metadata as Record<string, unknown> | null
      )?.["delegation_credential"];
      return credential ?? null;
    } catch {
      return null;
    }
  }

  public async cancelIntent(
    request: CancelIntentRequest,
  ): Promise<IntentCancelled | null> {
    // Re-verify the agent's Ghostbroker delegation VC is still valid for this
    // institution/agent pair. This catches the case where the
    // delegation was revoked after the intent was submitted.
    //
    // Note: we do NOT also look up the agent's DB record for the
    // revocations list (that's already fetched below). The
    // revocation flow already cascades through
    // `MatchingOrchestrator.removeIntentsByAgent`, which removes
    // revoked agents' pending intents from the queue. By the time a
    // cancel request arrives for a revoked agent, the intent will
    // already be gone and the orchestrator will return undefined
    // (mapped to 404). Adding a DB lookup here would be redundant
    // and would also fail for agents that were admitted via the
    // cryptographic layer but never persisted to the agents table
    // (e.g. legacy admissions).
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );

    const delegationCredential = await this.loadDelegationCredential(
      request.institutionId,
      request.agentDid,
    );

    const verification =
      await this.authorization.verifyAgentAuthority({
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        authorityRef: request.authorityRef,
        delegationCredential,
        // Same requested action as submission â€” the proof is
        // for the same scope of capabilities.
        requestedAction: "intent.submit",
        revokedAuthorityRefs,
      });

    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    if (!this.matchingOrchestrator) {
      // Without an orchestrator there is nothing to cancel.
      return null;
    }

    const removed = this.matchingOrchestrator.cancelIntent({
      intentHandle: request.intentHandle,
      agentDid: request.agentDid,
      institutionId: request.institutionId,
    });

    if (!removed) {
      return null;
    }

    // Best-effort: delete the lock ref so the orphan-lock
    // janitor does not see a stale row. The orchestrator has
    // already released the actual `portfolios.locked` amount
    // (via `releaseLockFor` inside `cancelIntent`); the ref
    // delete is the durable counterpart. If the delete fails
    // here, the janitor will pick it up after the TTL elapses
    // and call `releaseBalance` again â€” the second call is a
    // no-op because the lock amount is already zero.
    if (this.intentLockRepository) {
      try {
        await this.intentLockRepository.delete(request.intentHandle);
      } catch (error) {
        console.error(
          `[HiddenIntentService] Failed to delete lock ref for ${request.intentHandle}:`,
          error,
        );
      }
    }

    return {
      intentHandle: request.intentHandle,
      state: "intent_cancelled",
    };
  }

  public listPendingIntents(params: {
    institutionId: string;
    agentDid?: string;
  }): readonly PendingIntent[] {
    if (!this.matchingOrchestrator) {
      return [];
    }
    return this.matchingOrchestrator.listPendingIntents(params);
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
