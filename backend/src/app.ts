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
import { createAgentsRouter } from "./api/agents.routes.js";
import { operatorAuthMiddleware } from "./auth/operator-auth.js";
import { T3AgentAuthorizationFacade } from "./auth/agent-authz.js";
import { createSupabaseServiceClient } from "./services/supabase-client.js";
import {
  InstitutionService,
  SupabaseInstitutionRepository,
  type InstitutionManagementService,
} from "./services/institution.service.js";
import { SupabaseAuthorityRevocationRepository } from "./services/authority-revocation.service.js";
import { AgentService, type AgentAdmissionService } from "./services/agent.service.js";
import {
  HiddenIntentService,
  type HiddenIntentSubmissionService,
} from "./services/hidden-intent.service.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import {
  AdkTenantDidRegistry,
  DashboardDelegationAgentAuthClient,
  SandboxTokenBalanceClient,
  T3BlindIntentClient,
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
  agentService: AgentAdmissionService;
  hiddenIntentService?: HiddenIntentSubmissionService;
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

  const authorizationFacade = new T3AgentAuthorizationFacade(
    new DashboardDelegationAgentAuthClient(t3NetworkClient),
  );
  return {
    institutionService: new InstitutionService(
      institutionRepository,
      new AdkTenantDidRegistry(t3NetworkClient),
    ),
    agentService: new AgentService(
      authorizationFacade,
      authorityRevocationRepository,
    ),
    hiddenIntentService: new HiddenIntentService(
      authorizationFacade,
      new T3BlindIntentClient({
        networkClient: t3NetworkClient,
        tokenBalanceClient: new SandboxTokenBalanceClient(t3NetworkClient),
        tokenAccount: env.T3_TENANT_DID || "authenticated-tenant",
        minimumTokenBalance: 1n,
      }),
      telemetryBus,
      authorityRevocationRepository,
    ),
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
  app.use("/api", createInstitutionsRouter(services.institutionService));
  app.use(
    "/api",
    operatorAuthMiddleware(),
    createAgentsRouter(services.agentService, services.hiddenIntentService),
  );
  app.use(publicErrorHandler);

  return app;
}

export async function createProductionApp(
  env: BackendEnv = loadEnv(),
): Promise<Express> {
  return createApp(env, await createDefaultServices(env));
}
