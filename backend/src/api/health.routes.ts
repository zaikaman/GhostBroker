import { Router } from "express";
import type { BackendEnv } from "../config/env.js";

export type HealthStatus = "ok" | "degraded" | "unavailable";

export interface HealthResponse {
  status: HealthStatus;
  services: {
    backend: HealthStatus;
    supabase: HealthStatus;
    websocket: HealthStatus;
    t3: HealthStatus;
  };
}

function serviceStatus(value: string | undefined): HealthStatus {
  return value && value.trim().length > 0 ? "ok" : "unavailable";
}

function aggregateStatus(services: HealthResponse["services"]): HealthStatus {
  const statuses = Object.values(services);

  if (statuses.every((status) => status === "ok")) {
    return "ok";
  }

  return statuses.some((status) => status === "ok") ? "degraded" : "unavailable";
}

export function buildHealthResponse(
  env: Partial<BackendEnv>,
  websocketReady = true,
): HealthResponse {
  const services = {
    backend: "ok",
    supabase: serviceStatus(env.SUPABASE_URL),
    websocket: websocketReady ? "ok" : "unavailable",
    t3: serviceStatus(env.T3_NETWORK_URL),
  } satisfies HealthResponse["services"];

  return {
    status: aggregateStatus(services),
    services,
  };
}

export function createHealthRouter(env: Partial<BackendEnv>): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.json(buildHealthResponse(env));
  });

  return router;
}
