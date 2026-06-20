import { Router } from "express";
import type { BackendEnv } from "../config/env.js";
import {
  addressFromPrivateKey,
  didEthrForPrivateKey,
} from "../enclave/sandbox/tenant-identity-store.js";
import type { PublishedContractRepository } from "../services/published-contract.repository.js";

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
    t3: serviceStatus(env.T3N_API_KEY),
  } satisfies HealthResponse["services"];

  return {
    status: aggregateStatus(services),
    services,
  };
}

export interface EnclaveIdentityResponse {
  t3NetworkEnv: "testnet" | "production";
  t3TenantDid: string | null;
  matchingContractId: string | null;
  matchingContractVersion: string;
  tenantSigningAddress: string | null;
  tenantIssuerDid: string | null;
  attestationHandlePrefix: "t3attest:";
  publishedMatchingContract: {
    tail: "matching";
    contractVersion: string;
    publishedAt: string;
    tenantDid: string;
    networkEnv: "testnet" | "production";
    wasmSize: number;
    handle?: string;
  } | null;
}

const TENANT_SIGNING_KEY_REGEX = /^0x[0-9a-f]{64}$/iu;

export function buildEnclaveIdentityResponse(
  env: Partial<BackendEnv>,
): EnclaveIdentityResponse {
  const t3NetworkEnv: EnclaveIdentityResponse["t3NetworkEnv"] =
    env.T3N_ENV === "production" ? "production" : "testnet";

  let tenantSigningAddress: string | null = null;
  let tenantIssuerDid: string | null = null;
  if (
    typeof env.TENANT_SIGNING_PRIVATE_KEY === "string" &&
    TENANT_SIGNING_KEY_REGEX.test(env.TENANT_SIGNING_PRIVATE_KEY.trim())
  ) {
    const normalized = env.TENANT_SIGNING_PRIVATE_KEY.trim() as `0x${string}`;
    tenantSigningAddress = addressFromPrivateKey(normalized);
    tenantIssuerDid = didEthrForPrivateKey(normalized);
  }

  return {
    t3NetworkEnv,
    t3TenantDid: env.T3_TENANT_DID ?? null,
    matchingContractId: env.T3_MATCH_CONTRACT_ID ?? null,
    matchingContractVersion: env.T3_MATCHING_CONTRACT_VERSION ?? "0.7.0",
    tenantSigningAddress,
    tenantIssuerDid,
    attestationHandlePrefix: "t3attest:",
    publishedMatchingContract: null,
  };
}

export function createHealthRouter(
  env: Partial<BackendEnv>,
  publishedContractRepository?: PublishedContractRepository | undefined,
): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.json(buildHealthResponse(env));
  });

  router.get("/health/enclave", async (_request, response, next) => {
    try {
      const base = buildEnclaveIdentityResponse(env);
      const tenantDid = env.T3_TENANT_DID;
      if (publishedContractRepository && tenantDid) {
        base.publishedMatchingContract =
          await publishedContractRepository.loadLatestMatching({
            tenantDid,
            networkEnv: base.t3NetworkEnv,
          });
      }
      response.json(base);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
