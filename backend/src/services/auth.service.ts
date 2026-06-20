import { randomBytes, createHash } from "node:crypto";
import type { AgentIdentityVerifier } from "../enclave/index.js";
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
import type { ApiKeyManagementService } from "./api-key.service.js";
import type { DepositWalletService } from "./deposit-wallet.service.js";

interface ChallengeRecord {
  did: string;
  challengeHash: string;
  challenge: string;
  expiresAt: Date;
}

export interface AuthInstitutionRepository {
  findByTenantDid(did: string): Promise<Institution | null>;
  findById(id: string): Promise<Institution | null>;
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
  authenticateWithApiKey(apiKey: string): Promise<AuthSessionResponse>;
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

/**
 * Read the chain-rail deposit address from institution metadata.
 * The address is the one `settle()` pays out of (see the
 * `chain-sepolia-rail`), so it is the balance source of truth
 * for chain-rail institutions. Returns `undefined` when the
 * metadata has no `depositAddress` or it is not a valid 0x
 * address � callers must treat that as "no chain balance
 * source available" and fall back to stored DB balances.
 */
function readDepositAddress(institution: Institution): string | undefined {
  const raw = institution.metadata?.depositAddress;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  const match = /^(0x[0-9a-fA-F]{40})$/u.exec(raw.trim());
  return match?.[1]?.toLowerCase();
}

export class DidAuthService implements AuthSessionService {
  public constructor(params: {
    institutions: AuthInstitutionRepository;
    identityVerifier: AgentIdentityVerifier;
    walletPortfolioSyncService?: WalletPortfolioSyncService;
    apiKeyService: ApiKeyManagementService;
    sessionSecret: string;
    depositWalletService?: DepositWalletService;
    defaultChainTokenAddresses?: Readonly<Record<string, string>>;
  }) {
    this.institutions = params.institutions;
    this.identityVerifier = params.identityVerifier;
    this.walletPortfolioSyncService = params.walletPortfolioSyncService;
    this.apiKeyService = params.apiKeyService;
    this.sessionSecret = params.sessionSecret;
    this.depositWalletService = params.depositWalletService;
    this.defaultChainTokenAddresses = params.defaultChainTokenAddresses;
  }

  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly institutions: AuthInstitutionRepository;
  private readonly identityVerifier: AgentIdentityVerifier;
  private readonly walletPortfolioSyncService: WalletPortfolioSyncService | undefined;
  private readonly apiKeyService: ApiKeyManagementService;
  private readonly sessionSecret: string;
  private readonly depositWalletService: DepositWalletService | undefined;
  private readonly defaultChainTokenAddresses:
    | Readonly<Record<string, string>>
    | undefined;

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

      // Default new wallet-auth institutions onto the Sepolia
      // chain rail so assets actually move on-chain. The deposit
      // address is derived when a server-managed deposit wallet
      // service is configured; token addresses are attached when
      // the canonical token addresses are known. When neither is
      // available the institution is still on the chain rail path
      // so the dashboard shows the correct rail status — the
      // missing values must be set later through the Settings
      // panel or by wiring the env vars.
      const settlementProfileRef = "chain:sepolia:erc20";
      if (this.depositWalletService) {
        metadata.depositAddress =
          this.depositWalletService.deriveDepositAddress(did);
      }
      if (this.defaultChainTokenAddresses) {
        metadata.tokenAddresses = { ...this.defaultChainTokenAddresses };
      } else {
        metadata.tokenAddresses = {};
      }

      const institution = await this.institutions.createInstitution({
        legalName: walletDisplayName(did),
        displayName: walletDisplayName(did),
        settlementProfileRef,
        t3TenantDid: did,
        metadata,
      });

      return institution;
    } catch (err) {
      logger.warn(
        {
          err,
          did,
          event: "auth.find_or_create_institution_primary_failed",
        },
        "Primary institution create failed; checking for race winner.",
      );
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

    // For chain-rail institutions, the deposit wallet (not the
    // login wallet) is the balance source of truth: `settle()`
    // pays out of `metadata.depositAddress`. Portfolio sync must
    // therefore follow the deposit address when it exists, so the
    // DB portfolio mirrors the wallet the rail actually moves
    // funds from. For a chain-rail institution missing a deposit
    // address, we fall back to the connected login wallet,
    // preserving the legacy behaviour.
    const depositAddress = readDepositAddress(institution);
    const chainRailDepositAddress =
      institution.settlementProfileRef === "chain:sepolia:erc20"
        ? depositAddress
        : undefined;
    const syncWalletAddress = chainRailDepositAddress ?? connectedWalletAddress;

    if (syncWalletAddress && this.walletPortfolioSyncService) {
      try {
        await this.walletPortfolioSyncService.syncInstitutionPortfolio({
          institutionId: institution.id,
          walletAddress: syncWalletAddress,
        });
      } catch (error) {
        logger.warn(
          {
            err: error,
            institutionId: institution.id,
            walletAddress: syncWalletAddress,
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
      depositAddress?: string;
    } = {
      secret: this.sessionSecret,
      did: request.did,
      institutionId: institution.id,
    };

    if (connectedWalletAddress) {
      tokenParams.walletAddress = connectedWalletAddress;
    }
    if (chainRailDepositAddress) {
      tokenParams.depositAddress = chainRailDepositAddress;
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

  public async authenticateWithApiKey(apiKey: string): Promise<AuthSessionResponse> {
    const key = await this.apiKeyService.findKeyByToken(apiKey);

    if (!key) {
      throw new PublicError("authorization_failed", 401);
    }

    const institution = await this.institutions.findById(key.institutionId);

    if (!institution) {
      throw new PublicError("authorization_failed", 401);
    }

    if (institution.status !== "active") {
      throw new PublicError("authorization_failed", 401);
    }

    const token = issueOperatorSessionToken({
      secret: this.sessionSecret,
      did: `apikey:${key.id}`,
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
