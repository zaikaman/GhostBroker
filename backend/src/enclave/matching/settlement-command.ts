import { randomUUID } from "node:crypto";
import type {
  AgentDelegationVerificationResult,
  RequestedAgentAction,
} from "../auth/agent-auth-client.js";
import type { OpaqueMatchOutcome } from "./match-contract-client.js";

/**
 * The settlement command builder's authority facade. The
 * production facade (`T3AgentAuthorizationFacade`) implements
 * this directly; tests inject a stub.
 *
 * Both entrypoints route the call through `loadAndVerify`, which
 * looks up the persisted Ghostbroker delegation W3C VC by
 * `(institutionId, agentId)` and runs the same verifier the
 * admit-time path runs. The settlement path never relies on a
 * VC snapshot from the caller — the backend owns the VC
 * end-to-end.
 */
export interface SettlementAuthorityVerifier {
  loadAndVerify(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    requestedAction: RequestedAgentAction;
  }): Promise<AgentDelegationVerificationResult>;
}

export interface SettlementCommandRequest {
  matchOutcome: OpaqueMatchOutcome;
  /**
   * The admitted agent's record UUIDs for both sides. The
   * settlement command builder uses these to look up each side's
   * persisted Ghostbroker delegation VC and re-verify it for
   * `settlement.execute` before issuing the command.
   */
  buyerAgentId: string;
  sellerAgentId: string;
  buyerAgentDid: string;
  sellerAgentDid: string;
  /**
   * Optional caller-supplied revocations list for either side.
   * Currently unused (the facade's `loadAndVerify` runs the
   * verifier without a revocations arg), but kept on the request
   * shape so future hardening (e.g. session-scoped revocations
   * for negotiation sessions) can pass it without another
   * signature break.
   */
  revokedBuyerAuthorityRefs?: ReadonlySet<string>;
  revokedSellerAuthorityRefs?: ReadonlySet<string>;
  now?: Date;
}

export interface SettlementCommand {
  commandRef: string;
  outcomeRef: string;
  executionRef: string;
  buyerInstitutionId: string;
  sellerInstitutionId: string;
  encryptedTradeFieldsRef: string;
  submittedAt: string;
}

export class SettlementAuthorityError extends Error {
  public constructor() {
    super("Settlement authority recheck failed.");
    this.name = "SettlementAuthorityError";
  }
}

export class SettlementExpiredIntentError extends Error {
  public constructor() {
    super("Settlement match outcome expired.");
    this.name = "SettlementExpiredIntentError";
  }
}

export class SettlementCommandBuilder {
  private readonly authorityVerifier: SettlementAuthorityVerifier;

  public constructor(authorityVerifier: SettlementAuthorityVerifier) {
    this.authorityVerifier = authorityVerifier;
  }

  public async build(
    request: SettlementCommandRequest,
  ): Promise<SettlementCommand> {
    const now = request.now ?? new Date();

    if (Date.parse(request.matchOutcome.expiresAt) <= now.getTime()) {
      throw new SettlementExpiredIntentError();
    }

    // Re-verify both sides' persisted Ghostbroker delegation
    // VCs in parallel via the authorization facade's
    // `loadAndVerify`. The facade looks the VC up by
    // `(institutionId, agentId)` and runs the same verifier
    // the admit-time path runs. The settlement path no longer
    // takes a VC snapshot from the caller — the backend is
    // the single source of truth on the agent's authority.
    const [buyerAuthority, sellerAuthority] = await Promise.all([
      this.authorityVerifier.loadAndVerify({
        institutionId: request.matchOutcome.buyerInstitutionId,
        agentId: request.buyerAgentId,
        agentDid: request.buyerAgentDid,
        requestedAction: "settlement.execute",
      }),
      this.authorityVerifier.loadAndVerify({
        institutionId: request.matchOutcome.sellerInstitutionId,
        agentId: request.sellerAgentId,
        agentDid: request.sellerAgentDid,
        requestedAction: "settlement.execute",
      }),
    ]);

    if (
      buyerAuthority.status !== "verified" ||
      sellerAuthority.status !== "verified"
    ) {
      throw new SettlementAuthorityError();
    }

    return {
      commandRef: `settlement_${randomUUID()}`,
      outcomeRef: request.matchOutcome.outcomeRef,
      executionRef: request.matchOutcome.executionRef,
      buyerInstitutionId: request.matchOutcome.buyerInstitutionId,
      sellerInstitutionId: request.matchOutcome.sellerInstitutionId,
      encryptedTradeFieldsRef: request.matchOutcome.encryptedTradeFieldsRef,
      submittedAt: now.toISOString(),
    };
  }
}
