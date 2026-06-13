import { randomBytes, createHash } from "node:crypto";
import type { AgentIdentityVerifier } from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";
import type {
  AuthChallengeResponse,
  AuthVerifyRequest,
  AuthSessionResponse,
} from "../models/auth.js";
import type { Institution } from "../models/institution.js";
import type { PortfolioService } from "../services/portfolio.service.js";
import { createOpaqueId, issueOperatorSessionToken } from "../auth/session-token.js";

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
  const addressMatch = did.match(/:0x([0-9a-fA-F]{6,})/u);
  if (addressMatch) {
    return `Wallet 0x${addressMatch[1]!.toLowerCase().slice(0, 6)}`;
  }
  const shortDid = did.length > 24 ? `${did.slice(0, 20)}...` : did;
  return `Wallet ${shortDid}`;
}

export class DidAuthService implements AuthSessionService {


  public constructor(params: {
    institutions: AuthInstitutionRepository;
    identityVerifier: AgentIdentityVerifier;
    portfolioService?: PortfolioService;
    sessionSecret: string;
  }) {
    this.institutions = params.institutions;
    this.identityVerifier = params.identityVerifier;
    this.portfolioService = params.portfolioService;
    this.sessionSecret = params.sessionSecret;
  }

  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly institutions: AuthInstitutionRepository;
  private readonly identityVerifier: AgentIdentityVerifier;
  private readonly portfolioService: PortfolioService | undefined;
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
      const institution = await this.institutions.createInstitution({
        legalName: walletDisplayName(did),
        displayName: walletDisplayName(did),
        settlementProfileRef: "wallet:default",
        t3TenantDid: did,
        metadata: { source: "wallet_auth", type: "self_registered" },
      });

      // Seed initial portfolio for newly self-registered institution
      if (this.portfolioService) {
        await this.portfolioService
          .seedInitialPortfolio(institution.id)
          .catch(() => {
            // Portfolio seeding is best-effort; don't fail auth
          });
      }

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

    const token = issueOperatorSessionToken({
      secret: this.sessionSecret,
      did: request.did,
      institutionId: institution.id,
    });
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
