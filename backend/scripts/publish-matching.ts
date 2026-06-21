#!/usr/bin/env node
/**
 * Publish the GhostBroker matching TEE contract to T3N.
 *
 * Reads `backend/contracts/matching-policy/target/wasm32-wasip2/release/
 * matching_policy.wasm` (produced by
 * `cargo build --target wasm32-wasip2 --release` from inside
 * `backend/contracts/matching-policy/`) and publishes it under the
 * tail `matching` — the canonical name the GhostBroker
 * orchestrator hits at `/contracts/matching/blind-intents`
 * and `/contracts/matching/evaluate`.
 *
 * Idempotent: if the contract is already published at the
 * same tail + version, T3N returns a 4xx with
 * `code: "already_registered"` and the script exits 0
 * with a clear "already done" message. Bump
 * T3_MATCHING_CONTRACT_VERSION to push a new version.
 *
 * Run from the workspace root:
 *   npm run contract:publish:matching -w @ghostbroker/backend
 *
 * Or directly:
 *   npx tsx backend/scripts/publish-matching.ts
 *
 * Required (read from backend/.env):
 *   - T3N_API_KEY      T3N API key for your tenant
 *   - T3_TENANT_DID    The tenant DID T3N issued you
 * Optional:
 *   - T3N_ENV                            "testnet" (default) or "production"
 *   - T3_NETWORK_URL                     Override the testnet URL
 *   - T3_MATCHING_CONTRACT_VERSION       defaults to "0.10.0" (the
 *                                        v0.10.0 build that adds
 *                                        `seal-round-proposal` and
 *                                        `evaluate-round`; the same
 *                                        version covers `evaluate-match`,
 *                                        `seal-ticket`, and
 *                                        `evaluate-pair`). v0.13.0
 *                                        fixes kv-store map names to
 *                                        use canonical `z:<tenant>:<tail>`.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  T3nClient,
  TenantClient,
  createEthAuthInput,
  eth_get_address,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
  setNodeUrl,
} from "@terminal3/t3n-sdk";
import {
  SupabasePublishedContractRepository,
  type PublishedMatchingContractRecord,
} from "../src/services/published-contract.repository.js";
import { createSupabaseServiceClient } from "../src/services/supabase-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const BACKEND_ENV_PATH = resolve(REPO_ROOT, "backend/.env");
const WASM_PATH = resolve(
  REPO_ROOT,
  "backend/contracts/matching-policy/target/wasm32-wasip2/release/matching_policy.wasm",
);

function loadBackendEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(`backend/.env not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  // Process env wins over .env (so a one-off `T3_MATCHING_
  // CONTRACT_VERSION=0.1.1 npx tsx ...` overrides the file).
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function maskKey(value: string): string {
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function main(): Promise<void> {
  const env = loadBackendEnv(BACKEND_ENV_PATH);
  const apiKey = env.T3N_API_KEY;
  const configuredTenantDid = env.T3_TENANT_DID;
  const networkEnv = env.T3N_ENV ?? "testnet";
  const networkUrl = env.T3_NETWORK_URL;
  const version = env.T3_MATCHING_CONTRACT_VERSION ?? "0.13.0";
  const tail = "matching";

  if (!apiKey) {
    throw new Error("T3N_API_KEY is missing from backend/.env");
  }
  if (!configuredTenantDid) {
    throw new Error("T3_TENANT_DID is missing from backend/.env");
  }

  if (!existsSync(WASM_PATH)) {
    console.error(`✗ WASM artifact not found at ${WASM_PATH}`);
    console.error("  Build it first:");
    console.error("    cd backend/contracts/matching-policy");
    console.error("    cargo build --target wasm32-wasip2 --release");
    process.exit(1);
  }

  const wasm = new Uint8Array(readFileSync(WASM_PATH));

  console.log("── Publishing matching contract ──");
  console.log(`  T3N_API_KEY              = ${maskKey(apiKey)}`);
  console.log(`  T3N_ENV                  = ${networkEnv}`);
  console.log(
    `  T3_NETWORK_URL           = ${
      networkUrl && networkUrl.length > 0 ? networkUrl : "(SDK default)"
    }`,
  );
  console.log(`  T3_TENANT_DID            = ${configuredTenantDid}`);
  console.log(`  WASM path                = ${WASM_PATH}`);
  console.log(`  WASM size                = ${wasm.length} bytes`);
  console.log(`  contract tail            = ${tail}`);
  console.log(`  contract version         = ${version}`);
  console.log();

  // Authenticate against T3N and resolve the real tenant DID
  // the API key binds to. We rebuild the session from the
  // SDK directly (rather than going through t3-enclave's
  // factory) because we need the `TenantClient.contracts`
  // namespace to call `.publish(...)` — the factory wraps
  // the client and doesn't expose that surface.
  setEnvironment(networkEnv as "testnet" | "production");
  if (networkUrl && networkUrl.length > 0) {
    setNodeUrl(networkUrl);
  }
  const baseUrl = getNodeUrl(networkUrl);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(apiKey);
  const t3n = new T3nClient({
    baseUrl,
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, apiKey),
    },
  });

  let tenantDid = "";
  try {
    await t3n.handshake();
    const authResult = await t3n.authenticate(createEthAuthInput(address));
    tenantDid = authResult.value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ T3N authentication FAILED: ${message}`);
    console.error(
      "  → The T3N_API_KEY is invalid, revoked, or the testnet is down.",
    );
    process.exit(1);
  }

  if (!tenantDid.startsWith("did:t3n:")) {
    console.error(`✗ T3N returned a non-DID tenant identifier: ${tenantDid}`);
    process.exit(1);
  }

  console.log(`✓ authenticated as tenant ${tenantDid}`);
  if (tenantDid !== configuredTenantDid) {
    console.warn(
      `  ⚠ configured T3_TENANT_DID (${configuredTenantDid}) does not match`,
    );
    console.warn(
      `    the DID the API key authenticates as (${tenantDid}).`,
    );
    console.warn(
      "    Publishing under the authenticated DID; update backend/.env to align.",
    );
  }
  console.log();

  const tenant = new TenantClient({
    environment: networkEnv as "testnet" | "production",
    endpoint: baseUrl,
    baseUrl,
    tenantDid,
    t3n,
  });

  try {
    const result = await tenant.contracts.publish({
      tail,
      version,
      wasm,
    });
    console.log(`✓ Published contract "${tail}" v${version}`);
    if (result !== undefined && result !== null) {
      console.log(`  Result: ${JSON.stringify(result)}`);
    }
    const handle = extractPublishHandle(result);
    const record = await persistPublishedRecord({
      tenantDid,
      networkEnv: networkEnv as "testnet" | "production",
      contractVersion: version,
      wasmSize: wasm.length,
      ...(handle ? { handle } : {}),
    });
    console.log();
    console.log("── Persisted publish record ──");
    console.log(`  Table: public.published_contracts`);
    console.log(`  ${JSON.stringify(record)}`);
    console.log();
    console.log("── Next steps ──");
    console.log(`  The orchestrator will now find contracts at`);
    console.log(`  /contracts/${tail}/blind-intents, /contracts/${tail}/evaluate,`);
    console.log(`  /contracts/negotiation/tickets, and /contracts/negotiation/pairs`);
    console.log(`  and stop returning "matching not registered" on submit.`);
    console.log(
      `  The Settings → Enclave Connection panel now reflects the live publish.`,
    );
    console.log(
      `  Restart the backend (npm run dev) so the new T3 contract cache takes effect.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Idempotent re-publish: T3N returns a 4xx with
    // `code: "already_registered"` (or similar) when the
    // same tail+version is already on the tenant. Treat as
    // success so this script is safe to run multiple times.
    if (
      /already[_-]registered|already[_-]exists|conflict|already[_-]published/i.test(
        message,
      )
    ) {
      const record = await persistPublishedRecord({
        tenantDid,
        networkEnv: networkEnv as "testnet" | "production",
        contractVersion: version,
        wasmSize: wasm.length,
      });
      console.log(
        `✓ Contract "${tail}" v${version} already registered on tenant.`,
      );
      console.log(`  Recorded publish to public.published_contracts`);
      console.log(`  ${JSON.stringify(record)}`);
      console.log(
        "  (Re-run with T3_MATCHING_CONTRACT_VERSION bumped to publish a new version.)",
      );
      return;
    }
    console.error(`✗ Publish FAILED: ${message}`);
    process.exit(2);
  }
}

async function persistPublishedRecord(input: {
  tenantDid: string;
  networkEnv: "testnet" | "production";
  contractVersion: string;
  wasmSize: number;
  handle?: string;
}): Promise<PublishedMatchingContractRecord> {
  const env = loadBackendEnv(BACKEND_ENV_PATH);
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env " +
        "so publish-matching can record the result in the published_contracts table.",
    );
  }
  const supabase = createSupabaseServiceClient({
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
  const repository = new SupabasePublishedContractRepository(
    supabase as never,
  );
  const record: PublishedMatchingContractRecord = {
    tail: "matching",
    contractVersion: input.contractVersion,
    publishedAt: new Date().toISOString(),
    tenantDid: input.tenantDid,
    networkEnv: input.networkEnv,
    wasmSize: input.wasmSize,
    ...(input.handle ? { handle: input.handle } : {}),
  };
  await repository.upsertMatching(record);
  return record;
}

/**
 * Best-effort extraction of a string handle from the T3N publish result.
 * The SDK's return shape is not strictly typed in the public docs; we
 * probe the common fields. If none match, we persist without a handle
 * (the orchestrator resolves contracts by `tail` + `version`, not by
 * handle — the handle is informational for the Settings panel).
 */
function extractPublishHandle(result: unknown): string | undefined {
  if (typeof result === "string" && result.length > 0) {
    return result;
  }
  if (typeof result === "object" && result !== null) {
    const candidate = result as Record<string, unknown>;
    for (const key of ["handle", "id", "contractId", "contract_id"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const nested = candidate["contract"];
    if (typeof nested === "object" && nested !== null) {
      const id = (nested as Record<string, unknown>)["id"];
      if (typeof id === "string" && id.length > 0) {
        return id;
      }
    }
  }
  return undefined;
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
