import { randomBytes, createHash } from "node:crypto";
import type { AgentIdentityVerifier } from "@ghostbroker/t3-enclave";
import { logger } from "../logging/logger.js";
import { PublicError } from "../errors/public-error.js";
import type {
  AuthChallengeResponse,
  AuthVerifyRequest,
  AuthSessionResponse,
} from "../models/auth.js";
import type { Institution } from "../models/institution.js";
import { createOpaqueId, issueOperatorSessionToken } from "../auth/session-token.js";
import type { WalletPortfolioSyncService } from "./sepolia-portfolio-sync.service.js";

interface ChallengeRecord {
  did: string;
  challengeHash: string;
  challenge: string;
  expiresAt: Date;
}

export interface AuthInstitutionRepository {
  findByTenantDid(did: string): Promise<Institution | null>;
  createInstitution(value: {
    legalName: string;
    displayName: string;
    settlementProfileRef: string;
    t3TenantDid: string;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<Institution>;
}

export interface AuthSessionService {
  createChallenge(did: string): Promise<AuthChallengeResponse>;
  verifyChallenge(request: AuthVerifyRequest): Promise<AuthSessionResponse>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function walletDisplayName(did: string): string {
  const walletAddress = extractWalletAddressFromDid(did);
  if (walletAddress) {
    return `Wallet ${walletAddress.slice(0, 8)}`;
  }
  const shortDid = did.length > 24 ? `${did.slice(0, 20)}...` : did;
  return `Wallet ${shortDid}`;
}

function extractWalletAddressFromDid(did: string): string | undefined {
  const addressMatch = did.match(/:(0x[0-9a-fA-F]{40})$/u);
  return addressMatch?.[1]?.toLowerCase();
}

export class DidAuthService implements AuthSessionService {
  public constructor(params: {
    institutions: AuthInstitutionRepository;
    identityVerifier: AgentIdentityVerifier;
    walletPortfolioSyncService?: WalletPortfolioSyncService;
    sessionSecret: string;
  }) {
    this.institutions = params.institutions;
    this.identityVerifier = params.identityVerifier;
    this.walletPortfolioSyncService = params.walletPortfolioSyncService;
    this.sessionSecret = params.sessionSecret;
  }

  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly institutions: AuthInstitutionRepository;
  private readonly identityVerifier: AgentIdentityVerifier;
  private readonly walletPortfolioSyncService: WalletPortfolioSyncService | undefined;
  private readonly sessionSecret: string;

  private async findOrCreateInstitution(did: string): Promise<Institution> {
    const existing = await this.institutions.findByTenantDid(did);

    if (existing) {
      if (existing.status !== "active") {
        throw new PublicError("authorization_failed", 401);
      }
      return existing;
    }

    try {
      const metadata: Record<string, unknown> = {
        source: "wallet_auth",
        type: "self_registered",
      };

      const connectedWalletAddress = extractWalletAddressFromDid(did);
      if (connectedWalletAddress) {
        metadata.connectedWalletAddress = connectedWalletAddress;
      }

      const institution = await this.institutions.createInstitution({
        legalName: walletDisplayName(did),
        displayName: walletDisplayName(did),
        settlementProfileRef: "wallet:default",
        t3TenantDid: did,
        metadata,
      });

      return institution;
    } catch {
      // Race: another request may have just created this institution
      const retry = await this.institutions.findByTenantDid(did);
      if (retry && retry.status === "active") {
        return retry;
      }
      throw new PublicError("service_unavailable", 503);
    }
  }

  public async createChallenge(did: string): Promise<AuthChallengeResponse> {
    const institution = await this.findOrCreateInstitution(did);

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
    const nonce = randomBytes(32).toString("base64url");
    const challengeId = createOpaqueId("auth_challenge");
    const challenge = [
      "GhostBroker Terminal 3 DID authorization",
      `DID: ${did}`,
      `Institution: ${institution.id}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
    ].join("\n");

    this.challenges.set(challengeId, {
      did,
      challenge,
      challengeHash: hash(challenge),
      expiresAt,
    });

    return {
      challengeId,
      challenge,
      expiresAt: expiresAt.toISOString(),
    };
  }

  public async verifyChallenge(
    request: AuthVerifyRequest,
  ): Promise<AuthSessionResponse> {
    const record = this.challenges.get(request.challengeId);
    this.challenges.delete(request.challengeId);

    if (
      !record ||
      record.did !== request.did ||
      record.expiresAt.getTime() <= Date.now() ||
      record.challengeHash !== hash(record.challenge)
    ) {
      throw new PublicError("authorization_failed", 401);
    }

    const identityRequest: {
      did: string;
      challenge: string;
      signature: string;
      walletAddress?: string;
    } = {
      did: request.did,
      challenge: record.challenge,
      signature: request.signature,
    };

    if (request.walletAddress) {
      identityRequest.walletAddress = request.walletAddress;
    }

    const identity = await this.identityVerifier.verifyAgentIdentity(identityRequest);

    if (identity.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const institution = await this.findOrCreateInstitution(request.did);

    const connectedWalletAddress =
      request.walletAddress ?? extractWalletAddressFromDid(request.did);

    // Sync portfolio from Sepolia on authentication
    if (connectedWalletAddress && this.walletPortfolioSyncService) {
      try {
        await this.walletPortfolioSyncService.syncInstitutionPortfolio({
          institutionId: institution.id,
          walletAddress: connectedWalletAddress,
        });
      } catch (error) {
        logger.warn(
          {
            err: error,
            institutionId: institution.id,
            walletAddress: connectedWalletAddress,
          },
          "Failed to sync Sepolia wallet portfolio.",
        );
      }
    }

    const tokenParams: {
      secret: string;
      did: string;
      institutionId: string;
      walletAddress?: string;
    } = {
      secret: this.sessionSecret,
      did: request.did,
      institutionId: institution.id,
    };

    if (connectedWalletAddress) {
      tokenParams.walletAddress = connectedWalletAddress;
    }

    const token = issueOperatorSessionToken(tokenParams);
    const expiresAt = new Date(Date.now() + 60 * 60 * 8 * 1000).toISOString();

    return {
      token,
      expiresAt,
      institution: {
        id: institution.id,
        displayName: institution.displayName,
        t3TenantDid: institution.t3TenantDid,
      },
    };
  }
}