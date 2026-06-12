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
import { AgentService, type AgentAdmissionService } from "./services/agent.service.js";
import {
  AdkTenantDidRegistry,
  DashboardDelegationAgentAuthClient,
  FetchT3NetworkClient,
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
}

function createDefaultServices(env: BackendEnv): BackendServices {
  const t3NetworkClient = new FetchT3NetworkClient({
    networkUrl: env.T3_NETWORK_URL,
    tenantDid: env.T3_TENANT_DID,
    walletPrivateKeyRef: env.T3_WALLET_PRIVATE_KEY_REF,
  });
  const supabase = createSupabaseServiceClient(env);
  const institutionRepository = new SupabaseInstitutionRepository(
    supabase as never,
  );

  return {
    institutionService: new InstitutionService(
      institutionRepository,
      new AdkTenantDidRegistry(t3NetworkClient),
    ),
    agentService: new AgentService(
      new T3AgentAuthorizationFacade(
        new DashboardDelegationAgentAuthClient(t3NetworkClient),
      ),
    ),
  };
}

export function createApp(
  env: BackendEnv = loadEnv(),
  services: BackendServices = createDefaultServices(env),
): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(createCorsMiddleware(env));
  app.use(express.json({ limit: "1mb" }));
  app.use(correlationIdMiddleware());
  app.use("/api", createHealthRouter(env));
  app.use("/api", createInstitutionsRouter(services.institutionService));
  app.use("/api", operatorAuthMiddleware(), createAgentsRouter(services.agentService));
  app.use(publicErrorHandler);

  return app;
}
