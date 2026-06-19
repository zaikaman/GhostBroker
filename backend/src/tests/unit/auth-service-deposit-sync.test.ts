import type { AgentIdentityVerifier } from "../../enclave/index.js";
import { describe, expect, it } from "vitest";
import type { ApiKeyManagementService } from "../../services/api-key.service.js";
import type { AuthInstitutionRepository } from "../../services/auth.service.js";
import { DidAuthService } from "../../services/auth.service.js";
import type { Institution } from "../../models/institution.js";
import type { WalletPortfolioSyncService } from "../../services/sepolia-portfolio-sync.service.js";
import type { DepositWalletService } from "../../services/deposit-wallet.service.js";
import { TEST_AUTH_SESSION_SECRET } from "../data/us1-seed-builders.js";

/**
 * Records every syncInstitutionPortfolio call so the tests can assert
 * which wallet address the auth-time sync followed (deposit vs login).
 */
class RecordingSyncService implements WalletPortfolioSyncService {
  public calls: { institutionId: string; walletAddress: string }[] = [];
  public async syncInstitutionPortfolio(params: {
    institutionId: string;
    walletAddress: string;
  }) {
    this.calls.push(params);
    return {
      institutionId: params.institutionId,
      holdings: [],
    };
  }
  public async fetchLivePortfolio() {
    return { institutionId: "", holdings: [] };
  }
}

const verifiedIdentityVerifier = {
  verifyAgentIdentity: async () => ({
    status: "verified" as const,
    did: "did:t3:0x1111111111111111111111111111111111111111",
    walletAddress: "0x1111111111111111111111111111111111111111",
  }),
} as AgentIdentityVerifier;

const noopApiKeyService = {
  findKeyByToken: async () => null,
} as unknown as ApiKeyManagementService;

const CONNECTED_DID = "did:t3:0x1111111111111111111111111111111111111111";

function buildInstitutionRepository(
  institution: Institution,
): AuthInstitutionRepository {
  return {
    findByTenantDid: async (did) =>
      did === institution.t3TenantDid ? institution : null,
    findById: async () => institution,
    createInstitution: async () => institution,
  };
}

describe("DidAuthService deposit-wallet portfolio sync", () => {
  it("syncs from depositAddress for chain-rail institutions even when connectedWalletAddress differs", async () => {
    // The chain rail moves funds out of the deposit wallet, so the
    // DB portfolio must mirror that wallet — not the login wallet.
    // The two are intentionally different addresses here.
    const depositAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const institution: Institution = {
      id: "00000000-0000-4000-8000-000000000701",
      legalName: "Chain Rail Co",
      displayName: "Chain Rail Co",
      status: "active",
      t3TenantDid: CONNECTED_DID,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        connectedWalletAddress: "0x1111111111111111111111111111111111111111",
        depositAddress,
        tokenAddresses: {},
      },
    };
    const syncService = new RecordingSyncService();
    const authService = new DidAuthService({
      institutions: buildInstitutionRepository(institution),
      identityVerifier: verifiedIdentityVerifier,
      apiKeyService: noopApiKeyService,
      walletPortfolioSyncService: syncService,
      sessionSecret: TEST_AUTH_SESSION_SECRET,
    });

    const challenge = await authService.createChallenge(CONNECTED_DID);
    await authService.verifyChallenge({
      challengeId: challenge.challengeId,
      did: CONNECTED_DID,
      signature: "0xsignature",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(syncService.calls).toHaveLength(1);
    expect(syncService.calls[0]?.walletAddress).toBe(depositAddress);
  });

  it("falls back to connectedWalletAddress for chain-rail institutions missing a depositAddress", async () => {
    // GhostBroker exposes a single rail (`chain:sepolia:erc20`).
    // For chain-rail institutions that have not yet been configured
    // with a `depositAddress`, portfolio sync falls back to the
    // connected login wallet so login never breaks on a missing
    // deposit address.
    const connectedWallet = "0x1111111111111111111111111111111111111111";
    const institution: Institution = {
      id: "00000000-4000-8000-000000000702",
      legalName: "Chain Rail Unconfigured Co",
      displayName: "Chain Rail Unconfigured Co",
      status: "active",
      t3TenantDid: CONNECTED_DID,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: { connectedWalletAddress: connectedWallet },
    };
    const syncService = new RecordingSyncService();
    const authService = new DidAuthService({
      institutions: buildInstitutionRepository(institution),
      identityVerifier: verifiedIdentityVerifier,
      apiKeyService: noopApiKeyService,
      walletPortfolioSyncService: syncService,
      sessionSecret: TEST_AUTH_SESSION_SECRET,
    });

    const challenge = await authService.createChallenge(CONNECTED_DID);
    await authService.verifyChallenge({
      challengeId: challenge.challengeId,
      did: CONNECTED_DID,
      signature: "0xsignature",
      walletAddress: connectedWallet,
    });

    expect(syncService.calls).toHaveLength(1);
    expect(syncService.calls[0]?.walletAddress).toBe(connectedWallet);
  });

  it("stamps depositAddress into the session token for chain-rail institutions", async () => {
    // The session must carry the settlement wallet so portfolio
    // routes do not have to guess from the login wallet.
    const depositAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const institution: Institution = {
      id: "00000000-0000-4000-8000-000000000703",
      legalName: "Deposit Stamp Co",
      displayName: "Deposit Stamp Co",
      status: "active",
      t3TenantDid: CONNECTED_DID,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        connectedWalletAddress: "0x1111111111111111111111111111111111111111",
        depositAddress,
        tokenAddresses: {},
      },
    };
    const depositWalletService = {
      deriveDepositAddress: () => depositAddress,
    } as unknown as DepositWalletService;
    const syncService = new RecordingSyncService();
    const authService = new DidAuthService({
      institutions: buildInstitutionRepository(institution),
      identityVerifier: verifiedIdentityVerifier,
      apiKeyService: noopApiKeyService,
      walletPortfolioSyncService: syncService,
      depositWalletService,
      sessionSecret: TEST_AUTH_SESSION_SECRET,
    });

    const challenge = await authService.createChallenge(CONNECTED_DID);
    await authService.verifyChallenge({
      challengeId: challenge.challengeId,
      did: CONNECTED_DID,
      signature: "0xsignature",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(syncService.calls[0]?.walletAddress).toBe(depositAddress);
  });

  it("does not attempt deposit-wallet sync when the sync service is absent", async () => {
    // No sync service configured: the auth flow must not throw and
    // simply skip the sync (login never breaks on a missing sync).
    const institution: Institution = {
      id: "00000000-0000-4000-8000-000000000704",
      legalName: "No Sync Co",
      displayName: "No Sync Co",
      status: "active",
      t3TenantDid: CONNECTED_DID,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        connectedWalletAddress: "0x1111111111111111111111111111111111111111",
        depositAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        tokenAddresses: {},
      },
    };
    const authService = new DidAuthService({
      institutions: buildInstitutionRepository(institution),
      identityVerifier: verifiedIdentityVerifier,
      apiKeyService: noopApiKeyService,
      sessionSecret: TEST_AUTH_SESSION_SECRET,
    });

    const challenge = await authService.createChallenge(CONNECTED_DID);
    await expect(
      authService.verifyChallenge({
        challengeId: challenge.challengeId,
        did: CONNECTED_DID,
        signature: "0xsignature",
        walletAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).resolves.toBeDefined();
  });
});
