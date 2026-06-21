import { Router } from "express";
import type { BackendEnv } from "../config/env.js";
import {
  addressFromPrivateKey,
  didEthrForPrivateKey,
} from "../enclave/sandbox/tenant-identity-store.js";
import { DEFAULT_CONTRACT_VERSION } from "../enclave/contract-version.js";
import type { PublishedContractRepository } from "../services/published-contract.repository.js";
import type { PublishedMatchingContractRecord } from "../services/published-contract.repository.js";
import type { T3NetworkClient } from "../enclave/sandbox/t3n-client.js";
import { sealEnvelope, type EnvelopeMasterKey } from "../enclave/keys/envelope-cipher.js";
import { loadEnvelopeMasterKey } from "../enclave/keys/envelope-cipher.js";
import { randomUUID } from "node:crypto";

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
    matchingContractVersion: env.T3_MATCHING_CONTRACT_VERSION ?? DEFAULT_CONTRACT_VERSION,
    tenantSigningAddress,
    tenantIssuerDid,
    attestationHandlePrefix: "t3attest:",
    publishedMatchingContract: null,
  };
}

/**
 * Live TEE attestation quote returned by `GET /api/health/enclave/attestation`.
 *
 * The T3N SDK does not expose a raw attestation-quote API (documented
 * gap T3-ONB-008), so the verifiable evidence is a live `seal-intent`
 * contract execution against the published `matching` TEE contract.
 * Only a real enclave can return an opaque `intentHandle` +
 * `executionRef` + `attestationRef` bound to the pinned contract
 * version. A stubbed or unregistered contract surfaces as
 * `verified: false` with a populated `error`.
 */
export interface EnclaveAttestationResponse {
  verified: boolean;
  probedAt: string;
  networkEnv: "testnet" | "production";
  contractVersion: string;
  publishedMatchingContract: PublishedMatchingContractRecord | null;
  teeResponse: {
    intentHandle: string | null;
    executionRef: string | null;
    attestationRef: string | null;
    responseStatus: number;
  } | null;
  error: string | null;
}

interface T3SealIntentResponse {
  intent_handle?: string;
  execution_ref?: string;
  attestation_ref?: string;
}

interface T3SealIntentErrorBody {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
}

/**
 * Perform a live `seal-intent` probe against the published `matching`
 * TEE contract and return the TEE-issued artifacts that constitute the
 * attestation quote. The probe builds a real AES-256-GCM AEAD envelope
 * (using the same `sealEnvelope` the agent runtime uses) with a benign
 * sentinel payload, then submits it alongside the envelope master key
 * hex so the v0.9.1 contract's in-enclave decryption path runs
 * end-to-end. Only a real enclave can decrypt the envelope, validate
 * the fields, and return an opaque `intentHandle` + `executionRef` +
 * `attestationRef` bound to the pinned contract version.
 *
 * The probe is clearly labeled as a verification probe (correlation ref
 * prefixed `enclave-attestation-verify:`, agent DID
 * `did:t3n:enclave-attestation-verify`) so it is auditable as a
 * verification probe rather than a real trade — no balance reservation
 * is consumed and no match is ever evaluated against it. Exported for
 * unit tests so the probe payload + classification can be locked down
 * without a live T3N round-trip.
 */
export async function probeEnclaveAttestation(args: {
  networkClient: T3NetworkClient;
  contractVersion: string;
  tenantDid: string;
  correlationRef: string;
  envelopeMasterKey: EnvelopeMasterKey;
}): Promise<EnclaveAttestationResponse> {
  const probedAt = new Date().toISOString();
  const probeInstitutionId = `enclave-attestation-verify:${args.tenantDid}`;
  const probeAgentDid = "did:t3n:enclave-attestation-verify";
  const probeAuthorityRef = "ghostbroker-delegation:enclave-attestation-verify";

  // Build a real AEAD envelope with a benign sentinel payload. The
  // v0.9.1 contract decrypts this inside the TEE using the master
  // key hex we pass alongside it; a successful decryption + field
  // validation is the strongest possible proof the enclave is real.
  const encryptedIntent = sealEnvelope({
    institutionDid: probeInstitutionId,
    agentDid: probeAgentDid,
    authorityRef: probeAuthorityRef,
    payload: {
      institutionId: probeInstitutionId,
      agentDid: probeAgentDid,
      authorityRef: probeAuthorityRef,
      assetCode: "USDC",
      side: "buy",
      quantity: 1,
      price: 1,
      nonce: args.correlationRef,
    },
    masterKey: args.envelopeMasterKey,
  });

  const response = await args.networkClient.request<T3SealIntentResponse>({
    method: "POST",
    path: "/contracts/matching/blind-intents",
    body: {
      version: args.contractVersion,
      institution_id: probeInstitutionId,
      agent_did: probeAgentDid,
      encrypted_intent: encryptedIntent,
      envelope_master_key_hex: args.envelopeMasterKey.key.toString("hex"),
      authority_ref: probeAuthorityRef,
      correlation_ref: args.correlationRef,
    },
  });

  if (response.status < 200 || response.status >= 300) {
    const body = (response.body ?? {}) as T3SealIntentErrorBody;
    const code = typeof body.code === "string" ? body.code : "";
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.message === "string"
          ? body.message
          : "";
    const isNotRegistered =
      code === "not_found" ||
      detail.includes("not registered");
    return {
      verified: false,
      probedAt,
      networkEnv: "testnet",
      contractVersion: args.contractVersion,
      publishedMatchingContract: null,
      teeResponse: null,
      error: isNotRegistered
        ? `T3N tenant contract 'matching' is not registered (HTTP ${response.status}).`
        : `T3N rejected the attestation probe (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`,
    };
  }

  const intentHandle = response.body?.intent_handle ?? null;
  const executionRef = response.body?.execution_ref ?? null;
  const attestationRef = response.body?.attestation_ref ?? null;

  return {
    verified: intentHandle !== null,
    probedAt,
    networkEnv: "testnet",
    contractVersion: args.contractVersion,
    publishedMatchingContract: null,
    teeResponse: {
      intentHandle,
      executionRef,
      attestationRef,
      responseStatus: response.status,
    },
    error:
      intentHandle === null
        ? "T3N returned a 2xx but no intent_handle — the contract may be a stub."
        : null,
  };
}

export function createHealthRouter(
  env: Partial<BackendEnv>,
  publishedContractRepository?: PublishedContractRepository | undefined,
  t3NetworkClient?: T3NetworkClient | undefined,
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

  router.get("/health/enclave/attestation", async (_request, response, next) => {
    try {
      const base = buildEnclaveIdentityResponse(env);
      const tenantDid = env.T3_TENANT_DID;
      let publishedMatchingContract: PublishedMatchingContractRecord | null = null;
      if (publishedContractRepository && tenantDid) {
        publishedMatchingContract =
          await publishedContractRepository.loadLatestMatching({
            tenantDid,
            networkEnv: base.t3NetworkEnv,
          });
      }

      // No T3N client (test compositions / disabled T3) → honest
      // "not available" state rather than a fabricated quote.
      if (!t3NetworkClient) {
        const unavailable: EnclaveAttestationResponse = {
          verified: false,
          probedAt: new Date().toISOString(),
          networkEnv: base.t3NetworkEnv,
          contractVersion: base.matchingContractVersion,
          publishedMatchingContract,
          teeResponse: null,
          error:
            "T3N network client is not initialized. Set T3N_API_KEY and boot the backend with a live T3N handshake to verify the enclave.",
        };
        response.json(unavailable);
        return;
      }

      const contractVersion = publishedMatchingContract?.contractVersion
        ?? base.matchingContractVersion;
      const correlationRef = `enclave-attestation-verify:${randomUUID()}`;
      // Load the AEAD envelope master key so the probe can build a
      // real ciphertext the TEE will decrypt. `loadEnvelopeMasterKey`
      // falls back to a deterministic dev key when
      // ENVELOPE_ENCRYPTION_MASTER_KEY is unset — the probe still
      // proves the enclave is real (the TEE decrypts + validates the
      // fields either way); only the key strength differs in dev.
      const envelopeMasterKey = loadEnvelopeMasterKey();
      const quote = await probeEnclaveAttestation({
        networkClient: t3NetworkClient,
        contractVersion,
        tenantDid: tenantDid ?? "",
        correlationRef,
        envelopeMasterKey,
      });
      // Stamp the network env + published contract onto the quote
      // (probeEnclaveAttestation fills them with placeholders because
      // the function is also called from unit tests that don't have
      // the full env).
      quote.networkEnv = base.t3NetworkEnv;
      quote.publishedMatchingContract = publishedMatchingContract;
      response.json(quote);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
