import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  getCorsAllowedOrigins,
  loadEnv,
  type BackendEnv,
} from "./config/env.js";
import { toPublicError } from "./errors/public-error.js";
import { correlationIdMiddleware } from "./middleware/correlation-id.js";
import { createHealthRouter } from "./api/health.routes.js";
import { createInstitutionsRouter } from "./api/institutions.routes.js";
import { createPortfoliosRouter } from "./api/portfolios.routes.js";
import { createAgentsRouter } from "./api/agents.routes.js";
import {
  createNegotiationsRouter,
  mountAgentMandateRoute,
} from "./api/negotiations.routes.js";
import { createTradesRouter } from "./api/trades.routes.js";
import { createAdminRouter, type AdminRouterDeps } from "./api/admin.routes.js";
import { createReceiptsRouter } from "./api/receipts.routes.js";
import { createAuthRouter } from "./api/auth.routes.js";
import { operatorAuthMiddleware } from "./auth/operator-auth.js";
import { T3AgentAuthorizationFacade } from "./auth/agent-authz.js";
import { createSupabaseServiceClient } from "./services/supabase-client.js";
import {
  ApiKeyService,
  SupabaseApiKeyRepository,
  type ApiKeyManagementService,
} from "./services/api-key.service.js";
import { createDevTokenRouter } from "./api/dev-token.routes.js";
import {
  InstitutionService,
  SupabaseInstitutionRepository,
  type InstitutionManagementService,
} from "./services/institution.service.js";
import { DidAuthService, type AuthSessionService } from "./services/auth.service.js";
import { SupabaseAuthorityRevocationRepository, type AuthorityRevocationRepository } from "./services/authority-revocation.service.js";
import { AgentService, type AgentManagementService } from "./services/agent.service.js";
import { SupabaseAgentRepository } from "./services/agent-repository.js";
import {
  HiddenIntentService,
  type HiddenIntentSubmissionService,
} from "./services/hidden-intent.service.js";
import {
  SupabaseTradeHistoryRepository,
  TradeHistoryService,
} from "./services/trade-history.service.js";
import {
  ReceiptService,
  SupabaseReceiptRepository,
} from "./services/receipt.service.js";
import {
  SettlementService,
  SupabaseSettlementRepository,
} from "./services/settlement.service.js";
import {
  MapSettlementRailDispatcher,
  type SettlementRailDispatcher,
} from "./services/settlement-rails/dispatcher.js";
import { SepoliaErc20Rail } from "./services/settlement-rails/chain-sepolia-rail.js";
import type { SettlementRail } from "./services/settlement-rails/rail.js";
import { TeeAttestedRelayerSigner } from "./services/settlement-rails/relayer-signer.js";
import { createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HmacDepositWalletService } from "./services/deposit-wallet.service.js";
import { RepositoryInstitutionSettlementConfigResolver } from "./services/institution-settlement-config-resolver.js";
import { SupabaseSettlementReconciliationRepository } from "./services/settlement-reconciliation.repository.js";
import { SettlementReconciler } from "./services/settlement-reconciler.js";
import { PortfolioService } from "./services/portfolio.service.js";
import { SepoliaEtherscanPortfolioSyncService, type WalletPortfolioSyncService } from "./services/sepolia-portfolio-sync.service.js";
import { MatchingOrchestrator } from "./services/matching-orchestrator.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import {
  SupabaseIntentLockRepository,
  type IntentLockRepository,
} from "./services/intent-lock-repository.js";
import { IntentLockJanitor } from "./services/intent-lock-janitor.js";
import {
  BackendTenantDelegationSigner,
  type TenantDelegationSigner,
} from "./services/tenant-delegation-signer.js";
import { InstitutionApprovalService } from "./services/institution-approval.service.js";
import { InstitutionWithdrawalService } from "./services/institution-withdrawal.service.js";
import { createHostedAgentsRouter } from "./api/hosted-agents.routes.js";
import {
  ChildProcessHostedAgentService,
  type HostedAgentManagementService,
} from "./services/hosted-agent.service.js";
import { SupabaseNegotiationRepository } from "./services/negotiation-repository.js";
import {
  NegotiationService,
  type NegotiationManagementService,
} from "./services/negotiation.service.js";
import { NegotiationOrchestrator } from "./services/negotiation-orchestrator.js";
import {
  AdkTenantDidRegistry,
  SandboxTokenBalanceClient,
  SettlementCommandBuilder,
  T3BlindIntentClient,
  T3MatchContractClient,
  T3AgentIdentityVerifier,
  T3NegotiationDisclosureVerifier,
  T3NegotiationRoundEvaluator,
  T3NegotiationRoundClient,
  T3NegotiationTicketClient,
  createAuthenticatedT3NetworkClient,
  loadOrCreateTenantIdentityFromRepository,
  readT3EnclaveConfig,
  runStartupCheck,
  T3EnclaveConfigError,
  type AuthenticatedT3NetworkClientOptions,
  loadEnvelopeMasterKey,
} from "./enclave/index.js";
import { SupabasePublishedContractRepository, type PublishedContractRepository } from "./services/published-contract.repository.js";
import { SupabaseTenantIdentityRepository } from "./services/tenant-identity.repository.js";

function createCorsMiddleware(env: BackendEnv): RequestHandler {
  const allowedOrigins = getCorsAllowedOrigins(env);

  if (allowedOrigins.length === 0) {
    return cors();
  }

  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed."));
    },
  });
}

const publicErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  const publicError = toPublicError(error);    // Log 5xx server errors to the console so operators can see the
    // actual failure without scraping the network response. 4xx client
    // errors are also logged at warn level because the cause of a
    // validation failure is often the most actionable signal during
    // development.
  if (publicError.statusCode >= 500) {
    console.error(
      `[ERROR] ${_request.method} ${_request.path}: ${publicError.code} (${publicError.statusCode}) — ${publicError.message}`,
      error instanceof Error ? { stack: error.stack, cause: error.cause } : error,
    );
  } else if (publicError.statusCode >= 400) {
    console.warn(
      `[WARN] ${_request.method} ${_request.path}: ${publicError.code} (${publicError.statusCode}) — ${publicError.message}`,
      error instanceof Error ? error.message : error,
    );
  }
  response.status(publicError.statusCode).json(publicError.toResponse());
};

export interface BackendServices {
  institutionService: InstitutionManagementService;
  portfolioService: PortfolioService;
  walletPortfolioSyncService?: WalletPortfolioSyncService;
  agentService: AgentManagementService;
  hiddenIntentService?: HiddenIntentSubmissionService;
  settlementService?: SettlementService;
  /**
   * WS4: the settlement reconciler service. Optional so
   * test compositions that build `BackendServices` without
   * booting a real Supabase client can omit it. The
   * reconciler is the system task that periodically
   * verifies the chain state of `completed_trades` rows.
   */
  settlementReconciler?: SettlementReconciler;
  /**
   * WS4.2: the rail dispatcher used by the admin
   * reverser route to look up the rail that produced a
   * given trade and call `rail.reverse(...)`. The
   * dispatcher is the same instance the settlement
   * service uses; the field is a reference to it so
   * the admin route (mounted in `createApp`) does not
   * need to share a closure with `createDefaultServices`.
   */
  railDispatcher?: SettlementRailDispatcher;
  /**
   * Supabase-backed repository of every matching TEE contract the
   * backend has successfully published to the T3N tenant. The
   * Settings → Enclave Connection panel reads this so operators
   * see ground truth about what is actually registered, rather
   * than relying on env vars alone. Survives Heroku dyno restarts.
   * Optional so test compositions can omit it; the enclave
   * identity endpoint falls back to an empty repository that
   * always reports `publishedMatchingContract: null`.
   */
  publishedContractRepository?: PublishedContractRepository;
  tradeHistoryService?: TradeHistoryService;
  receiptService?: ReceiptService;
  authService?: AuthSessionService;
  apiKeyService: ApiKeyManagementService;
  matchingOrchestrator?: MatchingOrchestrator;
  intentLockRepository?: IntentLockRepository;
  intentLockJanitor?: IntentLockJanitor;
  /**
   * Phase 1: server-side delegation VC signer. Wired
   * when the T3N handshake at backend boot returned a
   * tenant DID. Optional so the test composition root
   * (which uses `BackendServices` without booting the
   * t3-enclave) can omit it.
   */
  tenantDelegationSigner?: TenantDelegationSigner;
  negotiationService?: NegotiationManagementService;
  hostedAgentService?: HostedAgentManagementService;
  institutionApprovalService?: InstitutionApprovalService;
  institutionWithdrawalService?: InstitutionWithdrawalService;
}

export async function createDefaultServices(env: BackendEnv): Promise<BackendServices> {
  const t3Options: AuthenticatedT3NetworkClientOptions = {
    apiKey: env.T3N_API_KEY,
    environment: env.T3N_ENV,
  };

  if (env.T3_NETWORK_URL) {
    t3Options.networkUrl = env.T3_NETWORK_URL;
  }

  if (env.T3_TENANT_DID) {
    t3Options.expectedTenantDid = env.T3_TENANT_DID;
  }

  const t3NetworkClient = await createAuthenticatedT3NetworkClient(t3Options);

  // Run the T3-enclave startup self-check. Strict in `production`
  // (refuses to boot on a malformed config), best-effort in
  // `development` / `test` (emits warnings only). The runtime
  // gate on agent authority is the GhostBroker-style W3C VC
  // verifier itself (see `t3-enclave/src/auth/ghostbroker-
  // delegation.ts`); the startup check is a structural sanity
  // sweep, not an authority gate.
  const t3EnclaveConfig = readT3EnclaveConfig();
  try {
    const startupResult = runStartupCheck(t3EnclaveConfig, {
      nodeEnv: env.NODE_ENV,
    });
    if (startupResult.warnings.length > 0) {
      console.warn(
        "[t3-enclave] startup check warnings:\n" +
          startupResult.warnings.map((w: string) => `  - ${w}`).join("\n"),
      );
    }
  } catch (error: unknown) {
    if (error instanceof T3EnclaveConfigError) {
      throw new Error(
        `T3 enclave startup check failed (NODE_ENV=${env.NODE_ENV}): ${(error as T3EnclaveConfigError).issues.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }

  const supabase = createSupabaseServiceClient(env);
  const institutionRepository = new SupabaseInstitutionRepository(
    supabase as never,
  );
  const tenantIdentityRepository = new SupabaseTenantIdentityRepository(
    supabase as never,
  );
  const publishedContractRepository = new SupabasePublishedContractRepository(
    supabase as never,
  );
  const depositWalletService =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED
      ? new HmacDepositWalletService(
          env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED,
        )
      : undefined;
  const defaultChainTokenAddresses: Record<string, string> = {};
  const defaultWbtcAddress =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS ??
    env.SEPOLIA_WBTC_CONTRACT_ADDRESS;
  const defaultUsdcAddress =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS ??
    env.SEPOLIA_USDC_CONTRACT_ADDRESS;
  if (defaultWbtcAddress) {
    defaultChainTokenAddresses["WBTC"] = defaultWbtcAddress;
  }
  if (defaultUsdcAddress) {
    defaultChainTokenAddresses["USDC"] = defaultUsdcAddress;
  }
  const authorityRevocationRepository =
    new SupabaseAuthorityRevocationRepository(supabase as never);

  const apiKeyRepository = new SupabaseApiKeyRepository(supabase as never);
  const intentLockRepository = new SupabaseIntentLockRepository(
    supabase as never,
  );

  // Phase 1: tenant identity. The T3N handshake returned
  // an authenticated tenant DID. The signing keypair is
  // SEPARATE from the T3N bearer API key — the API key is the
  // operator's claim-page secret and may be rotated on a
  // schedule independent of the institution's VC lifecycle
  // (rotating it would invalidate every issued VC, so it must
  // not be conflated with the signing key).
  //
  // Resolution order:
  //
  //   1. `TENANT_SIGNING_PRIVATE_KEY` env var (production):
  //      operators load a long-lived secp256k1 key from a
  //      secret manager (KMS / Vault / HSM) and inject it at
  //      boot. The same key is reused across restarts; existing
  //      VCs stay valid.
  //
  //   2. Supabase `tenant_identities` row (Heroku-safe dev /
  //      production fallback): the keypair persists in the
  //      `tenant_identities` table so Heroku dyno restarts do
  //      NOT regenerate the keypair and silently invalidate
  //      every previously issued delegation VC. This replaces
  //      the previous `output/identities/tenant_identity.json`
  //      file-based store, which was wiped on every Heroku
  //      dyno cycle.
  //
  // The resulting keypair's derived address is the canonical
  // VC issuer DID (`did:ethr:0x<address>`). Server-minted VCs
  // have `signer == issuer`, so the T3 SDK's `verifyEcdsaVcSig`
  // matches the issuer against the recovered signer and
  // returns `isValid: true` directly. There is no manual
  // fallback path — the verifier is SDK-only.
  const tenantIdentity = await loadOrCreateTenantIdentityFromRepository(
    tenantIdentityRepository,
    {
      tenantDid: t3NetworkClient.tenantDidValue,
      ...(env.TENANT_SIGNING_PRIVATE_KEY
        ? { signingPrivateKey: env.TENANT_SIGNING_PRIVATE_KEY }
        : {}),
    },
  );
  const tenantDelegationSigner = new BackendTenantDelegationSigner(
    tenantIdentity,
  );

  // Ghostbroker-only authorization facade. Constructed
  // before the agent service so we can late-bind the
  // service into the facade after both are built (the
  // facade's `loadAndVerify` needs the service to look
  // up the persisted VC; the agent service needs the
  // facade for `verifyAgentAuthority` at admit time).
  const authorizationFacade = new T3AgentAuthorizationFacade();
  const tokenBalanceClient = new SandboxTokenBalanceClient(t3NetworkClient);
  const portfolioService = new PortfolioService(
    supabase as never,
    env.SETTLEMENT_ASSET_CODE,
  );

  const walletPortfolioSyncService =
    env.ETHERSCAN_API_KEY &&
    env.SEPOLIA_WBTC_CONTRACT_ADDRESS &&
    env.SEPOLIA_USDC_CONTRACT_ADDRESS
      ? new SepoliaEtherscanPortfolioSyncService(portfolioService, {
          apiKey: env.ETHERSCAN_API_KEY,
          wbtcContractAddress: env.SEPOLIA_WBTC_CONTRACT_ADDRESS,
          usdcContractAddress: env.SEPOLIA_USDC_CONTRACT_ADDRESS,
        })
      : undefined;

  // WS2: build the rail registry. GhostBroker exposes a single
  // settlement rail — `chain:sepolia:erc20`. The chain rail's
  // env vars are mandatory: a backend boot without them has no
  // rail to dispatch through, and any settlement would fail
  // closed with `service_unavailable`. The previous noop fallback
  // (`wallet:default`) has been removed.
  if (
    !env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL ||
    !env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY ||
    !env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS
  ) {
    throw new Error(
      "Settlement rail env vars are required: " +
        "SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL, " +
        "SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY, and " +
        "SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS must all be set. " +
        "GhostBroker ships a single settlement rail (`chain:sepolia:erc20`) " +
        "and cannot boot without it.",
    );
  }
  // WS2.5: the relayer signer is a deliberate seam.
  // v1 demo path: a `ViemWalletRelayerSigner` that
  // signs the broadcast with the
  // `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`
  // env var. The on-chain `from` is the address
  // derived from this key.
  //
  // Production-swap path: a `TeeAttestedRelayerSigner`
  // whose `tenantPrivateKey` is the T3 tenant identity
  // loaded via `t3-enclave`'s
  // `loadOrCreateTenantIdentity(...)`. The
  // production tenant key is held inside the T3
  // tenant TEE; the v1 demo's tenant key is the
  // file-backed keypair the matching-policy contract
  // also uses. The on-chain `from` is the tenant
  // identity's address either way; in production
  // the key's extraction is attestation-anchored.
  //
  // The decision: when
  // `SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF` is
  // set (a T3 secret-ref, e.g. `t3_secret:abc123`),
  // the wiring resolves it through the `t3-enclave`'s
  // secret store and builds a TEE-attested signer.
  // Otherwise the v1 viem path runs (the env var is
  // empty in the demo).
  const useTeeSigner = Boolean(
    process.env["SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF"],
  );
  let tenantPrivateKeyForRail: `0x${string}` | undefined;
  if (useTeeSigner) {
    // Production: the relayer's tenant key is the T3
    // tenant identity. `loadOrCreateTenantIdentityFromRepository`
    // reads the Supabase-backed keypair so the relayer's
    // signer is consistent with the backend's tenant
    // identity across Heroku dyno restarts.
    const tenantIdentity = await loadOrCreateTenantIdentityFromRepository(
      tenantIdentityRepository,
      {
        tenantDid:
          env.T3_TENANT_DID ?? "did:t3n:tenant:default-relayer",
      },
    );
    tenantPrivateKeyForRail = tenantIdentity.privateKey as `0x${string}`;
  }

  const relayerSigner = useTeeSigner
    ? new TeeAttestedRelayerSigner({
        // The `walletClient` is still used for the
        // EIP-1559 broadcast; the v1 demo's T3N does
        // not expose a TEE-attested relayer
        // primitive yet (T3-ONB-011). Production:
        // this `walletClient` is replaced with a
        // TEE-attested client whose key is held
        // inside the tenant TEE.
        walletClient: createWalletClient({
          account: privateKeyToAccount(
            env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY as `0x${string}`,
          ),
          chain: defineChain({
            id: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID ?? 11155111,
            name:
              (env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID ?? 11155111) ===
              11155111
                ? "Sepolia"
                : "anvil-test",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: {
              default: { http: [env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL] },
            },
          }),
          transport: http(env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL),
        }),
        // The T3 tenant identity's private key. In
        // v1 demo this is the file-backed keypair;
        // in production this is the TEE-held key
        // (T3-ONB-011).
        tenantPrivateKey:
          (tenantPrivateKeyForRail ??
            env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY) as `0x${string}`,
        // `false` for the v1 demo (the key is
        // file-backed, not TEE-held). Production
        // sets this to `true` once T3N exposes the
        // tenant-TEE key store.
        isTeeAttested: false,
      })
    : undefined;

  const railRegistry = new Map<string, SettlementRail>([
    [
      "chain:sepolia:erc20",
      new SepoliaErc20Rail(
        {
          rpcUrl: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL,
          // viem types `relayerPrivateKey` as a `0x${string}` template
          // literal; the env-validator's regex narrows the runtime
          // shape but not the TS literal type, so we cast here.
          relayerPrivateKey:
            env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY as `0x${string}`,
          relayerContractAddress:
            env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS as `0x${string}`,
          chainId: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID ?? 11155111,
          confirmTimeoutSec: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_CONFIRM_TIMEOUT_SEC ?? 90,
        },
        relayerSigner
          ? {
              relayerSigner,
            }
          : {},
      ),
    ],
  ]);
  const railDispatcher = new MapSettlementRailDispatcher(railRegistry);

  let institutionApprovalService: InstitutionApprovalService | undefined;
  let institutionWithdrawalService: InstitutionWithdrawalService | undefined;
  const chainWbtcAddress =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS ??
    env.SEPOLIA_WBTC_CONTRACT_ADDRESS;
  const chainUsdcAddress =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS ??
    env.SEPOLIA_USDC_CONTRACT_ADDRESS;
  if (
    depositWalletService &&
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL &&
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY &&
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS &&
    chainWbtcAddress &&
    chainUsdcAddress
  ) {
    const chainId = env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID ?? 11155111;
    institutionWithdrawalService = new InstitutionWithdrawalService({
      institutionRepository,
      depositWalletService,
      rpcUrl: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL,
      chainId,
      wbtcAddress: chainWbtcAddress as `0x${string}`,
      usdcAddress: chainUsdcAddress as `0x${string}`,
    });
    institutionApprovalService = new InstitutionApprovalService({
      institutionRepository,
      depositWalletService,
      rpcUrl: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL,
      chainId,
      relayerContractAddress:
        env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS as `0x${string}`,
      wbtcAddress: chainWbtcAddress as `0x${string}`,
      usdcAddress: chainUsdcAddress as `0x${string}`,
    });
  }

  // WS2: production resolver for per-institution settlement
  // config (settlement_profile_ref + metadata). Wired from the
  // existing institution repository. The settlement service
  // uses this to pick the rail per side and to look up the
  // chain rail's per-institution deposit addresses.
  const institutionConfigResolver = new RepositoryInstitutionSettlementConfigResolver(
    institutionRepository,
  );

  // WS4: settlement reconciler. Periodically polls
  // `completed_trades` for unreconciled rows and verifies
  // the chain state via `rail.status(railTradeRef)`. Drift
  // is surfaced via a `rail_drift_detected` telemetry event
  // and the row's `reconciled_at` is set to a sentinel
  // timestamp so the next sweep does not loop on the
  // same drift forever.
  const settlementReconciler = new SettlementReconciler(
    new SupabaseSettlementReconciliationRepository(supabase as never),
    railDispatcher,
    telemetryBus,
  );

  const settlementService = new SettlementService(
    new SettlementCommandBuilder(authorizationFacade),
    new SupabaseSettlementRepository(supabase as never),
    telemetryBus,
    undefined, // audit sink
    portfolioService,
    railDispatcher,
    institutionConfigResolver,
  );

  const blindIntentClient = new T3BlindIntentClient({
    networkClient: t3NetworkClient,
    tokenBalanceClient,
    tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
    minimumTokenBalance: 1n,
    settlementAssetCode: env.SETTLEMENT_ASSET_CODE,
    envelopeMasterKeyHex: loadEnvelopeMasterKey().key.toString("hex"),
  });

  const matchContractClient = new T3MatchContractClient({
    networkClient: t3NetworkClient,
    tokenBalanceClient,
    tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
    minimumTokenBalance: 1n,
    // Pin the match-authoritative contract version so the T3N
    // adapter routes `evaluate-match` to the published build that
    // decides the cross, fill quantity, and execution price
    // (rather than relying on the tenant's default registration).
    contractVersion: env.T3_MATCHING_CONTRACT_VERSION,
  });

  const matchingOrchestrator = new MatchingOrchestrator(
    matchContractClient,
    settlementService,
    telemetryBus,
    portfolioService,
    env.SETTLEMENT_ASSET_CODE,
    undefined, // intentTtlMs
    undefined, // cleanupIntervalMs
    intentLockRepository,
    institutionConfigResolver,
  );

  // The orphan-lock janitor: runs every 30s in production, finds
  // lock refs older than the intent TTL, and releases the
  // corresponding `portfolios.locked` amount. This is the
  // recovery path for process restarts that would otherwise
  // strand reservations.
  const intentLockJanitor = new IntentLockJanitor(
    intentLockRepository,
    portfolioService,
    { telemetryBus },
  );

  const apiKeyService = new ApiKeyService(
    apiKeyRepository,
    env.AUTH_SESSION_SECRET,
  );
  const institutionService = new InstitutionService(
    institutionRepository,
    new AdkTenantDidRegistry(t3NetworkClient),
    depositWalletService,
    defaultChainTokenAddresses,
  );
  const agentService = buildAgentService({
    authorizationFacade,
    matchingOrchestrator,
    supabase: supabase as never,
    authorityRevocationRepository,
  });
  const negotiationRepository = new SupabaseNegotiationRepository(supabase as never);
  const negotiationTicketClient = new T3NegotiationTicketClient({
    networkClient: t3NetworkClient,
    tokenBalanceClient,
    tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
    minimumTokenBalance: 1n,
    // Pin the seal-ticket / evaluate-pair contract version to
    // match `T3MatchContractClient` so the negotiation pairing
    // gate (the TEE's `evaluate-pair`) and the per-round match
    // authority (the TEE's `evaluate-match`) both run on the
    // same published version. The T3N adapter
    // (`readVersionFromBody`) reads this off the body and
    // routes the execution; without it the tenant falls back
    // to its default version, which may not yet expose
    // `evaluate-pair`.
    contractVersion: env.T3_MATCHING_CONTRACT_VERSION,
  });
  const negotiationRoundEvaluator = new T3NegotiationRoundEvaluator(
    new T3NegotiationRoundClient({
      networkClient: t3NetworkClient,
      tokenBalanceClient,
      tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
      minimumTokenBalance: 1n,
      // Pin the seal-round-proposal / evaluate-round contract
      // version so the negotiation cross-evaluation path runs
      // on the same published build as the rest of the matching
      // / negotiation tenant contracts. The T3N adapter
      // (`readVersionFromBody`) reads this off the body and
      // routes execution; without it the tenant falls back to
      // its default version, which may not yet expose
      // `seal-round-proposal`.
      contractVersion: env.T3_MATCHING_CONTRACT_VERSION,
    }),
  );
  const negotiationDisclosureVerifier = new T3NegotiationDisclosureVerifier();
  const negotiationOrchestrator = new NegotiationOrchestrator({
    ticketClient: negotiationTicketClient,
    roundEvaluator: negotiationRoundEvaluator,
    disclosureVerifier: negotiationDisclosureVerifier,
    authorization: authorizationFacade,
    repository: negotiationRepository,
    settlementService,
    telemetryBus,
    portfolioService,
    settlementAssetCode: env.SETTLEMENT_ASSET_CODE,
    agentRepository: new SupabaseAgentRepository(supabase as never),
    envelopeMasterKeyHex: loadEnvelopeMasterKey().key.toString("hex"),
  });
  const negotiationService = new NegotiationService({
    repository: negotiationRepository,
    agentService,
    tenantSigner: tenantDelegationSigner,
    orchestrator: negotiationOrchestrator,
  });

  return {
    institutionService,
    portfolioService,
    ...(walletPortfolioSyncService ? { walletPortfolioSyncService } : {}),
    agentService,
    hiddenIntentService: new HiddenIntentService(
      authorizationFacade,
      blindIntentClient,
      telemetryBus,
      matchingOrchestrator,
      new SupabaseAgentRepository(supabase as never),
      portfolioService,
      intentLockRepository,
    ),
    settlementService,
    settlementReconciler,
    railDispatcher,
    tradeHistoryService: new TradeHistoryService(
      new SupabaseTradeHistoryRepository(supabase as never),
    ),
    receiptService: new ReceiptService(new SupabaseReceiptRepository(supabase as never)),
    apiKeyService,
    matchingOrchestrator,
    intentLockRepository,
    intentLockJanitor,
    tenantDelegationSigner,
    negotiationService,
    ...(institutionApprovalService ? { institutionApprovalService } : {}),
    ...(institutionWithdrawalService ? { institutionWithdrawalService } : {}),
    hostedAgentService: (() => {
      // The `agent:hosted` npm script is `tsx src/cli/agents/hosted-agent.ts`.
      // `tsx` is a devDependency, so on Heroku (NODE_ENV=production → npm
      // skips devDependencies) it is never installed and the child exits
      // with code 127 (`tsx: not found`) — the dashboard's hosted-agent
      // logTail shows "Runtime exited code=127" and the negotiator never
      // polls. In production we therefore spawn the compiled
      // `dist/src/cli/agents/hosted-agent.js` directly with node, the
      // same way the Procfile boots the backend (`node dist/src/server.js`).
      // In development the default `npm run hosted` path is preserved so
      // a developer iterating on `src/cli/agents/hosted-agent.ts` still
      // gets tsx on-the-fly.
      const COMPILED_HOSTED_AGENT = "dist/src/cli/agents/hosted-agent.js";
      const productionRunner =
        env.NODE_ENV === "production"
          ? ({
              runner: ["node"] as const,
              hostedScript: COMPILED_HOSTED_AGENT,
            } as const)
          : ({} as const);
      if (env.NODE_ENV === "production") {
        const compiledAbsolute = resolvePath(
          env.AGENTS_WORKSPACE_DIR ?? ".",
          COMPILED_HOSTED_AGENT,
        );
        if (!existsSync(compiledAbsolute)) {
          throw new Error(
            `Refusing to boot in NODE_ENV=production: compiled hosted-agent entrypoint not found at ${compiledAbsolute}. ` +
              "Heroku should run `npm run build:backend` via the `heroku-postbuild` script in the root package.json before the Procfile boots the server; verify the build step completed and that AGENTS_WORKSPACE_DIR matches the deployed tree.",
          );
        }
      }
      return new ChildProcessHostedAgentService({
        // Default to the backend's own directory (where package.json
        // with the "agent:hosted" script lives). On Heroku the app
        // is deployed from a single directory, so "." works there too.
        // Override via AGENTS_WORKSPACE_DIR env var if needed.
        agentsDir: env.AGENTS_WORKSPACE_DIR ?? ".",
        backendUrl: `http://localhost:${env.PORT}`,
        authSessionSecret: env.AUTH_SESSION_SECRET,
        agentService,
        institutionService: institutionService as Required<Pick<InstitutionManagementService, "getInstitution">>,
        negotiationService,
        ...(institutionApprovalService ? { institutionApprovalService } : {}),
        ...productionRunner,
        // Hosted agents need the institution's tenant signing keypair
        // (whose derived `did:ethr:0x<address>` is the only issuer
        // format `@terminal3/verify_vc`'s `verifyEcdsaVcSig` accepts)
        // to mint W3C claim VCs the disclosure verifier can hand to
        // the SDK without it throwing "Unsupported DID method: t3n".
        // The agent process gets the private key + derived DID as
        // env vars at spawn time; it uses the env-supplied values
        // for claim VCs while keeping the backend-assigned
        // `AGENT_IDENTITY_DID` (`did:t3n:...`) for admit / ticket
        // calls — those are bound to the institution's T3 identity,
        // not to the signing keypair.
        //
        // The single-tenant dev / demo path uses the backend-wide
        // tenant identity (`tenantIdentity`, loaded once at boot
        // from `T3_TENANT_DID` / `TENANT_SIGNING_PRIVATE_KEY`) for
        // every institution's hosted agent. The institution's own
        // `t3_tenant_did` field uses the `did:t3:0x<wallet>` format
        // — a different shape than the `tenant_identities` primary
        // key (`did:t3n:0x<addr>`, the T3N handshake identifier) —
        // so a per-institution lookup against the table would miss
        // in the dev path. The shared backend-wide row is the
        // authoritative keypair for claim VC signing until the
        // table is partitioned per-institution.
        tenantIdentityLookup: async () => ({
          signingPrivateKey: tenantIdentity.privateKey,
          signingPublicKey: tenantIdentity.publicKey,
          issuerDid: tenantIdentity.did,
        }),
      });
    })(),
    authService: new DidAuthService({
      institutions: institutionRepository,
      identityVerifier: new T3AgentIdentityVerifier(t3NetworkClient),
      ...(walletPortfolioSyncService ? { walletPortfolioSyncService } : {}),
      apiKeyService,
      ...(depositWalletService ? { depositWalletService } : {}),
      ...(Object.keys(defaultChainTokenAddresses).length > 0
        ? { defaultChainTokenAddresses }
        : {}),
      sessionSecret: env.AUTH_SESSION_SECRET,
    }),
    publishedContractRepository,
  };
}

function buildAgentService(input: {
  authorizationFacade: T3AgentAuthorizationFacade;
  matchingOrchestrator: MatchingOrchestrator;
  supabase: unknown;
  authorityRevocationRepository: AuthorityRevocationRepository;
}): AgentService {
  const service = new AgentService(
    input.authorizationFacade,
    new SupabaseAgentRepository(input.supabase as never),
    input.authorityRevocationRepository,
    input.matchingOrchestrator,
  );
  // Late-bind the agent service into the facade so
  // `loadAndVerify` can look up the persisted VC. The
  // facade and the service form a cycle (the service
  // holds a facade reference for `verifyAgentAuthority`,
  // the facade holds a service reference for
  // `loadAndVerify`); this constructor-then-setter
  // pattern is the standard escape hatch.
  input.authorizationFacade.setAgentService(service);
  return service;
}

export function createApp(
  env: BackendEnv = loadEnv(),
  services: BackendServices,
): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(createCorsMiddleware(env));
  app.use(express.json({ limit: "1mb" }));
  app.use(correlationIdMiddleware());
  app.use("/api", createHealthRouter(env, services?.publishedContractRepository));
  if (services.authService) {
    app.use("/api", createAuthRouter(services.authService));
  }
  // Dev-only token minting endpoint for Playwright E2E tests and local
  // development. Never mount in production — this issues real signed JWTs
  // for an arbitrary institutionId with no DID challenge, which would
  // bypass the wallet-auth security model.
  if (env.NODE_ENV !== "production") {
    app.use("/api", createDevTokenRouter(env));
  }
  app.use(
    "/api",
    createInstitutionsRouter(
      services.institutionService,
      operatorAuthMiddleware(env, services.apiKeyService),
      {
        ...(services.institutionApprovalService
          ? { approvalService: services.institutionApprovalService }
          : {}),
        ...(services.institutionWithdrawalService
          ? { withdrawalService: services.institutionWithdrawalService }
          : {}),
      },
    ),
  );
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    createPortfoliosRouter(
      services.portfolioService,
      services.walletPortfolioSyncService,
      services.matchingOrchestrator,
    ),
  );
  const agentsRouter = createAgentsRouter(
    services.agentService,
    services.hiddenIntentService,
    services.tenantDelegationSigner,
  );
  if (services.negotiationService) {
    mountAgentMandateRoute({
      router: agentsRouter,
      negotiationService: services.negotiationService,
    });
  }
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    agentsRouter,
  );
  if (services.negotiationService) {
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createNegotiationsRouter(services.negotiationService),
    );
  }
  if (services.tradeHistoryService) {
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createTradesRouter(services.tradeHistoryService),
    );
  }
  if (services.receiptService) {
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createReceiptsRouter(services.receiptService),
    );
  }
  if (services.hostedAgentService) {
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createHostedAgentsRouter(services.hostedAgentService),
    );
  }
  // WS4.2: admin reverser route. The rail dispatcher is
  // always present in production (the noop rail is the
  // universal fallback). The trade-history service is
  // required for the reverser to fetch the trade row.
  if (services.railDispatcher && services.tradeHistoryService) {
    const adminDeps: AdminRouterDeps = {
      railDispatcher: services.railDispatcher,
      tradeHistoryService: services.tradeHistoryService,
      telemetryBus,
    };
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createAdminRouter(adminDeps, operatorAuthMiddleware(env, services.apiKeyService)),
    );
  }
  app.use(publicErrorHandler);

  return app;
}

export async function createProductionApp(
  env: BackendEnv = loadEnv(),
): Promise<Express> {
  return createApp(env, await createDefaultServices(env));
}



