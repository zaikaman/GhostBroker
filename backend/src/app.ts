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
import {
  InstitutionService,
  SupabaseInstitutionRepository,
  type InstitutionManagementService,
} from "./services/institution.service.js";
import { DidAuthService, type AuthSessionService } from "./services/auth.service.js";
import { SupabaseAuthorityRevocationRepository } from "./services/authority-revocation.service.js";
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
import { PortfolioService } from "./services/portfolio.service.js";
import { SepoliaEtherscanPortfolioSyncService, type WalletPortfolioSyncService } from "./services/sepolia-portfolio-sync.service.js";
import { MatchingOrchestrator } from "./services/matching-orchestrator.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import {
  AdkTenantDidRegistry,
  DashboardDelegationAgentAuthClient,
  SandboxTokenBalanceClient,
  SettlementCommandBuilder,
  T3BlindIntentClient,
  T3MatchContractClient,
  T3AgentIdentityVerifier,
  createAuthenticatedT3NetworkClient,
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
  tradeHistoryService?: TradeHistoryService;
  receiptService?: ReceiptService;
  authService?: AuthSessionService;
  apiKeyService: ApiKeyManagementService;
}

async function createDefaultServices(env: BackendEnv): Promise<BackendServices> {
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
  const supabase = createSupabaseServiceClient(env);
  const institutionRepository = new SupabaseInstitutionRepository(
    supabase as never,
  );
  const authorityRevocationRepository =
    new SupabaseAuthorityRevocationRepository(supabase as never);

  const apiKeyRepository = new SupabaseApiKeyRepository(supabase as never);

  const authorizationFacade = new T3AgentAuthorizationFacade(
    new DashboardDelegationAgentAuthClient(t3NetworkClient),
  );
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

  const settlementService = new SettlementService(
    new SettlementCommandBuilder(authorizationFacade),
    new SupabaseSettlementRepository(supabase as never),
    telemetryBus,
    undefined, // audit sink
    portfolioService,
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
  );

  return {
    institutionService: new InstitutionService(
      institutionRepository,
      new AdkTenantDidRegistry(t3NetworkClient),
    ),
    portfolioService,
    ...(walletPortfolioSyncService ? { walletPortfolioSyncService } : {}),
    agentService: new AgentService(
      authorizationFacade,
      new SupabaseAgentRepository(supabase as never),
      authorityRevocationRepository,
      matchingOrchestrator,
    ),
    hiddenIntentService: new HiddenIntentService(
      authorizationFacade,
      blindIntentClient,
      telemetryBus,
      authorityRevocationRepository,
      matchingOrchestrator,
      new SupabaseAgentRepository(supabase as never),
    ),
    settlementService,
    tradeHistoryService: new TradeHistoryService(
      new SupabaseTradeHistoryRepository(supabase as never),
    ),
    receiptService: new ReceiptService(new SupabaseReceiptRepository(supabase as never)),
    apiKeyService: new ApiKeyService(apiKeyRepository),
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
  app.use("/api", createInstitutionsRouter(services.institutionService));
  app.use(
    "/api",
    operatorAuthMiddleware(env),
    createPortfoliosRouter(services.portfolioService, services.walletPortfolioSyncService),
  );
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    createApiKeysRouter(services.apiKeyService),
  );
  app.use(
    "/api",
    operatorAuthMiddleware(env, services.apiKeyService),
    createAgentsRouter(services.agentService, services.hiddenIntentService),
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
  app.use(publicErrorHandler);

  return app;
}

export async function createProductionApp(
  env: BackendEnv = loadEnv(),
): Promise<Express> {
  return createApp(env, await createDefaultServices(env));
}
