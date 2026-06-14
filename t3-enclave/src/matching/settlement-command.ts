import { randomUUID } from "node:crypto";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "../auth/agent-auth-client.js";
import type { OpaqueMatchOutcome } from "./match-contract-client.js";

export interface SettlementAuthorityVerifier {
  /**
   * Re-verify the agent's Ghostbroker delegation W3C VC for the action the
   * settlement is about to perform. The verifier needs the
   * `delegationCredential` (the Ghostbroker delegation VC persisted at admit
   * time) and the `authorityRef` the agent echoed back on submit,
   * to confirm the agent is presenting the same credential it
   * was admitted with.
   */
  verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
}

export interface SettlementCommandRequest {
  matchOutcome: OpaqueMatchOutcome;
  buyerAgentDid: string;
  sellerAgentDid: string;
  buyerDelegationCredential: unknown;
  sellerDelegationCredential: unknown;
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

    const [buyerAuthority, sellerAuthority] = await Promise.all([
      this.authorityVerifier.verifyAgentAuthority({
        institutionId: request.matchOutcome.buyerInstitutionId,
        agentDid: request.buyerAgentDid,
        authorityRef: request.matchOutcome.buyerAuthorityRef,
        delegationCredential: request.buyerDelegationCredential,
        requestedAction: "settlement.execute",
        ...(request.revokedBuyerAuthorityRefs !== undefined
          ? { revokedAuthorityRefs: request.revokedBuyerAuthorityRefs }
          : {}),
      }),
      this.authorityVerifier.verifyAgentAuthority({
        institutionId: request.matchOutcome.sellerInstitutionId,
        agentDid: request.sellerAgentDid,
        authorityRef: request.matchOutcome.sellerAuthorityRef,
        delegationCredential: request.sellerDelegationCredential,
        requestedAction: "settlement.execute",
        ...(request.revokedSellerAuthorityRefs !== undefined
          ? { revokedAuthorityRefs: request.revokedSellerAuthorityRefs }
        : {}),
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
