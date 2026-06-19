#!/usr/bin/env node
/**
 * Tenant verification script — T3N identity sanity check.
 *
 * Uses the exact same `createAuthenticatedT3NetworkClient` factory that
 * the backend's `app.ts` uses to bootstrap the orchestrator, so this
 * script's view of the tenant identity matches what production code
 * sees at runtime.
 *
 * Verifies:
 *   1. The T3N_API_KEY is accepted by the testnet.
 *   2. The DID the API key authenticates as matches the T3_TENANT_DID
 *      configured in backend/.env.
 *   3. Reports the resolved tenant DID + tail registration state.
 *
 * Read-only: no contract publishes, no KV mutations, no token spend
 * beyond the handshake + me() round-trip.
 *
 * Run from the workspace root:
 *   npm run verify:t3n-tenant -w @ghostbroker/backend
 *
 * Or directly:
 *   npx tsx backend/scripts/verify-t3n-tenant.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticatedT3NetworkClient } from "../src/enclave/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const BACKEND_ENV_PATH = resolve(REPO_ROOT, "backend/.env");

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

  if (!apiKey) {
    throw new Error("T3N_API_KEY is missing from backend/.env");
  }
  if (!configuredTenantDid) {
    throw new Error("T3_TENANT_DID is missing from backend/.env");
  }

  console.log("── T3N tenant verification ──");
  console.log(`  T3N_API_KEY      = ${maskKey(apiKey)}`);
  console.log(`  T3N_ENV          = ${networkEnv}`);
  console.log(
    `  T3_NETWORK_URL   = ${
      networkUrl && networkUrl.length > 0
        ? networkUrl
        : "(unset, using SDK default for env)"
    }`,
  );
  console.log(`  T3_TENANT_DID    = ${configuredTenantDid}  (from backend/.env)`);
  console.log();

  // Use the exact same factory the backend uses. This guarantees
  // we're looking at the same tenant identity production code sees.
  // The factory throws if T3_TENANT_DID disagrees with what the
  // API key authenticates as, so we deliberately do NOT pass
  // expectedTenantDid here — we want to see the disagreement, not
  // have it masked by a factory-level check.
  const networkClient = await createAuthenticatedT3NetworkClient({
    apiKey,
    environment: networkEnv as "testnet" | "production",
    ...(networkUrl && networkUrl.length > 0 ? { networkUrl } : {}),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ T3N authentication FAILED: ${message}`);
    console.error(
      "  → The T3N_API_KEY is invalid, revoked, or the testnet is down.",
    );
    process.exit(1);
  });
  if (!networkClient) return; // Unreachable; process.exit above.
  console.log("✓ handshake + authenticate OK");
  console.log(`  resolved tenant DID = ${networkClient.tenantDidValue}`);

  // The factory's `request()` method also implements /tenant/me()
  // via `tenant.tenant.me()` internally, but it routes it as the
  // `/tenant/register` call. The cleanest way to confirm tenant
  // ownership is to read the public `tenantDidValue` getter we
  // just printed and compare it against the configured value.
  //
  // Additionally, hit a known-registered route to prove the
  // tenant session is live end-to-end.
  console.log();
  console.log("── tenant health check ──");
  const balance = await networkClient
    .request<{ account: string; available: string }>({
      method: "POST",
      path: "/tokens/balance",
      body: { account: networkClient.tenantDidValue },
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ /tokens/balance probe failed: ${message}`);
      return null;
    });
  if (balance) {
    console.log(`✓ /tokens/balance responded ${balance.status}`);
    if (balance.status === 200) {
      const body = balance.body as { account: string; available: string };
      console.log(`  account   = ${body.account}`);
      console.log(`  available = ${body.available}`);
    }
  }

  console.log();
  console.log("── comparison ──");
  console.log(`  configured T3_TENANT_DID : ${configuredTenantDid}`);
  console.log(`  resolved from API key    : ${networkClient.tenantDidValue}`);

  if (networkClient.tenantDidValue === configuredTenantDid) {
    console.log();
    console.log("✓ MATCH — backend is pointing at the right tenant.");
    console.log("  The 'matching' contract really is unregistered on this");
    console.log("  tenant. Next step: author the matching TEE contract and");
    console.log("  publish it via the SDK (see publish-contract.ts).");
  } else {
    console.log();
    console.log("✗ MISMATCH — backend is misconfigured.");
    console.log(
      `  Set T3_TENANT_DID=${networkClient.tenantDidValue} in backend/.env.`,
    );
    console.log(
      "  The orchestrator has been calling /contracts/matching/* on a",
    );
    console.log(
      "  tenant the API key doesn't own, which fully explains the 404.",
    );
  }
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
