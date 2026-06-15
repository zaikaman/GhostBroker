import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";
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
import { createApiKeysRouter } from "./api/api-keys.routes.js";
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
import { NoopCustodialRail } from "./services/settlement-rails/noop-custodial-rail.js";
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
import {
  ChildProcessDemoAgentOrchestrator,
  type DemoAgentOrchestrator,
} from "./services/demo-orchestrator.js";
import { InstitutionFundingService } from "./services/institution-funding.service.js";
import { InstitutionWithdrawalService } from "./services/institution-withdrawal.service.js";
import { createDemoRouter } from "./api/demo.routes.js";
import {
  AdkTenantDidRegistry,
  SandboxTokenBalanceClient,
  SettlementCommandBuilder,
  T3BlindIntentClient,
  T3MatchContractClient,
  T3AgentIdentityVerifier,
  createAuthenticatedT3NetworkClient,
  loadOrCreateTenantIdentity,
  readT3EnclaveConfig,
  runStartupCheck,
  T3EnclaveConfigError,
  type AuthenticatedT3NetworkClientOptions,
} from "@ghostbroker/t3-enclave";

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
  const publicError = toPublicError(error);
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
  /**
   * Phase 2.5: Demo Mode orchestrator. Owns the
   * lifecycle of the buyer + seller child processes
   * spawned on the dashboard's "Spin up demo agents"
   * button. Optional so the test composition root can
   * omit it; production boots it in `createDefaultServices`.
   */
  demoAgentOrchestrator?: DemoAgentOrchestrator;
  institutionFundingService?: InstitutionFundingService;
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
        `T3 enclave startup check failed (NODE_ENV=${env.NODE_ENV}): ${error.issues.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }

  const supabase = createSupabaseServiceClient(env);
  const institutionRepository = new SupabaseInstitutionRepository(
    supabase as never,
  );
  const depositWalletService =
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED
      ? new HmacDepositWalletService(
          env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED,
        )
      : undefined;
  const defaultChainTokenAddresses: Record<string, string> = {};
  if (env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS) {
    defaultChainTokenAddresses["WBTC"] =
      env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS;
  }
  if (env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS) {
    defaultChainTokenAddresses["USDC"] =
      env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS;
  }
  const authorityRevocationRepository =
    new SupabaseAuthorityRevocationRepository(supabase as never);

  const apiKeyRepository = new SupabaseApiKeyRepository(supabase as never);
  const intentLockRepository = new SupabaseIntentLockRepository(
    supabase as never,
  );

  // Phase 1: tenant identity. The T3N handshake returned
  // an authenticated tenant DID; we use it as the issuer
  // of every server-minted delegation VC. The signing
  // keypair is generated locally on first boot and
  // persisted to `output/identities/tenant_identity.json`
  // so a backend restart re-uses the same identity and
  // existing VCs stay valid.
  const tenantIdentity = loadOrCreateTenantIdentity({
    tenantDid: t3NetworkClient.tenantDidValue,
  });
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

  // WS2: build the rail registry. The noop rail is always
  // registered (universal fallback). The chain rail is
  // registered only when all three of its env vars are set;
  // otherwise every `chain:sepolia:erc20` profile falls through
  // to the noop rail. This is the documented opt-in path: a
  // missing or empty env value disables the rail without
  // breaking existing flows.
  const railRegistry = new Map<string, SettlementRail>([
    ["wallet:default", new NoopCustodialRail()],
  ]);
  if (
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL &&
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY &&
    env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS
  ) {
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
      // tenant identity. `loadOrCreateTenantIdentity`
      // reads the file-backed keypair that
      // `t3-enclave` already produces; in the
      // production T3-tenant-TEE the same call returns
      // a TEE-held key.
      const { loadOrCreateTenantIdentity } = await import(
        "@ghostbroker/t3-enclave"
      );
      const tenantIdentity = loadOrCreateTenantIdentity({
        tenantDid:
          env.T3_TENANT_DID ?? "did:t3n:tenant:default-relayer",
      });
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

    railRegistry.set(
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
    );
  }
  const railDispatcher = new MapSettlementRailDispatcher(railRegistry);

  let institutionFundingService: InstitutionFundingService | undefined;
  let institutionWithdrawalService: InstitutionWithdrawalService | undefined;
  const chainWbtcAddress = env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS;
  const chainUsdcAddress = env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS;
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
    if (env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_FAUCET_PRIVATE_KEY) {
      institutionFundingService = new InstitutionFundingService({
        institutionRepository,
        depositWalletService,
        rpcUrl: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL,
        chainId,
        faucetPrivateKey:
          env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_FAUCET_PRIVATE_KEY as `0x${string}`,
        relayerContractAddress:
          env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS as `0x${string}`,
        relayerPrivateKey:
          env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY as `0x${string}`,
        wbtcAddress: chainWbtcAddress as `0x${string}`,
        usdcAddress: chainUsdcAddress as `0x${string}`,
        defaultFunding: {
          eth: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_FUND_ETH_DEFAULT ?? "0.5",
          wbtc: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_FUND_WBTC_DEFAULT ?? "0.1",
          usdc: env.SETTLEMENT_RAIL_CHAIN_SEPOLIA_FUND_USDC_DEFAULT ?? "1000",
        },
      });
    }
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
  });

  const matchContractClient = new T3MatchContractClient({
    networkClient: t3NetworkClient,
    tokenBalanceClient,
    tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
    minimumTokenBalance: 1n,
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

  return {
    institutionService: new InstitutionService(
      institutionRepository,
      new AdkTenantDidRegistry(t3NetworkClient),
      depositWalletService,
      defaultChainTokenAddresses,
    ),
    portfolioService,
    ...(walletPortfolioSyncService ? { walletPortfolioSyncService } : {}),
    agentService: buildAgentService({
      authorizationFacade,
      matchingOrchestrator,
      supabase: supabase as never,
      authorityRevocationRepository,
    }),
    hiddenIntentService: new HiddenIntentService(
      authorizationFacade,
      blindIntentClient,
      telemetryBus,
      authorityRevocationRepository,
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
    apiKeyService: new ApiKeyService(apiKeyRepository),
    matchingOrchestrator,
    intentLockRepository,
    intentLockJanitor,
    tenantDelegationSigner,
    ...(institutionFundingService ? { institutionFundingService } : {}),
    ...(institutionWithdrawalService ? { institutionWithdrawalService } : {}),
    demoAgentOrchestrator: new ChildProcessDemoAgentOrchestrator({
      agentsDir: env.AGENTS_WORKSPACE_DIR ?? "../agents",
      backendUrl: `http://localhost:${env.PORT}`,
      apiKeyService: new ApiKeyService(apiKeyRepository),
    }),
    authService: new DidAuthService({
      institutions: institutionRepository,
      identityVerifier: new T3AgentIdentityVerifier(t3NetworkClient),
      ...(walletPortfolioSyncService ? { walletPortfolioSyncService } : {}),
      apiKeyService: new ApiKeyService(apiKeyRepository),
      sessionSecret:
        env.AUTH_SESSION_SECRET ??
        "development-only-auth-session-secret-change-before-production",
    }),
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
  app.use("/api", createHealthRouter(env));
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
        ...(services.institutionFundingService
          ? { fundingService: services.institutionFundingService }
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
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    createApiKeysRouter(services.apiKeyService),
  );
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    createAgentsRouter(
      services.agentService,
      services.hiddenIntentService,
      services.tenantDelegationSigner,
    ),
  );
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
  if (services.demoAgentOrchestrator) {
    app.use(
      "/api",
      operatorAuthMiddleware(env, services.apiKeyService),
      createDemoRouter({
        orchestrator: services.demoAgentOrchestrator,
        apiKeyService: services.apiKeyService,
        agentService: services.agentService,
        // With exactOptionalPropertyTypes, we use a spread to
        // omit the key entirely when the signer is absent
        // rather than passing `undefined` explicitly.
        ...(services.tenantDelegationSigner
          ? { tenantSigner: services.tenantDelegationSigner }
          : {}),
      }),
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
