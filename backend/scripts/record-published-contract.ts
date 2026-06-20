#!/usr/bin/env node
/**
 * Backfill the `published_contracts` table with a record for a
 * matching contract that was already published to T3N (typically
 * before this table existed, or when a previous publish script
 * was interrupted between T3N success and DB write).
 *
 * Use this script when:
 *
 *   - You ran `publish-matching.ts` against a fresh DB and the
 *     T3N call returned a `bad_request: contract version invalid:
 *     version X is not higher than current version X` error.
 *     T3N has the version. The DB row is missing. Run this
 *     script with the same env vars to populate the DB row
 *     without re-publishing.
 *
 *   - You restored the DB from a snapshot that predates the
 *     `published_contracts` table but T3N still has the contract.
 *
 * This script does NOT call `tenant.contracts.publish(...)`. It
 * only writes the row that `publish-matching.ts` would have
 * written on success. The Settings → Enclave Connection panel
 * reads this table; backfilling it is enough to make the panel
 * show the live publish state.
 *
 * Required (read from backend/.env):
 *   - T3N_API_KEY                (used for tenant verification, see below)
 *   - T3_TENANT_DID              The tenant DID T3N issued you
 *   - SUPABASE_URL               Supabase project URL
 *   - SUPABASE_SERVICE_ROLE_KEY  Supabase service role key
 * Optional:
 *   - T3N_ENV                            "testnet" (default) or "production"
 *   - T3_MATCHING_CONTRACT_VERSION       defaults to "0.6.0"
 *
 * Run from the workspace root:
 *   npx tsx backend/scripts/record-published-contract.ts
 *
 * Override the version with:
 *   T3_MATCHING_CONTRACT_VERSION=0.7.0 npx tsx backend/scripts/record-published-contract.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SupabasePublishedContractRepository,
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

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env " +
        "so the row can be upserted into public.published_contracts.",
    );
  }
  const configuredTenantDid = env.T3_TENANT_DID;
  if (!configuredTenantDid) {
    throw new Error("T3_TENANT_DID is missing from backend/.env");
  }
  const networkEnv = env.T3N_ENV ?? "testnet";
  const version = env.T3_MATCHING_CONTRACT_VERSION ?? "0.6.0";
  const tail = "matching";

  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `WASM artifact not found at ${WASM_PATH}. ` +
        "Build it with: cd backend/contracts/matching-policy && cargo build --target wasm32-wasip2 --release",
    );
  }
  const wasmBytes = readFileSync(WASM_PATH);
  const wasmSize = wasmBytes.byteLength;

  console.log("── Backfilling published_contracts row ──");
  console.log(`  T3_TENANT_DID            = ${configuredTenantDid}`);
  console.log(`  T3N_ENV                  = ${networkEnv}`);
  console.log(`  contract tail            = ${tail}`);
  console.log(`  contract version         = ${version}`);
  console.log(`  WASM size                = ${wasmSize} bytes`);
  console.log(`  T3N_API_KEY              = ${maskKey(env.T3N_API_KEY ?? "")}`);
  console.log();

  console.log(
    "  Note: this script does NOT call tenant.contracts.publish. " +
      "It only writes the row the publish-matching script would " +
      "have written on success. Run publish-matching.ts with a " +
      "new T3_MATCHING_CONTRACT_VERSION to actually publish a " +
      "new contract.",
  );
  console.log();

  const supabase = createSupabaseServiceClient({
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
  const repository = new SupabasePublishedContractRepository(
    supabase as never,
  );

  const record = {
    tail: tail as "matching",
    contractVersion: version,
    publishedAt: new Date().toISOString(),
    tenantDid: configuredTenantDid,
    networkEnv: networkEnv as "testnet" | "production",
    wasmSize,
  };
  await repository.upsertMatching(record);

  console.log("✓ Upserted row into public.published_contracts");
  console.log(`  ${JSON.stringify(record, null, 2)}`);
  console.log();
  console.log("── Next steps ──");
  console.log(
    "  Open the dashboard Settings → Enclave Connection panel; the",
  );
  console.log(
    "  Matching Contract row should now display the live publish",
  );
  console.log(
    "  state (version, WASM size, publish timestamp).",
  );
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
