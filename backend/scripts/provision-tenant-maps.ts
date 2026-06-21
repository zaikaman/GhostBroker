#!/usr/bin/env node
/**
 * Provision the T3N kv-store maps the v0.10.0 matching contract
 * writes to (`intents`, `rounds`).
 *
 * Run once after publishing the matching contract. Idempotent —
 * safe to re-run; T3N returns "map already exists" which the
 * provisioner treats as success.
 *
 * Run from the workspace root:
 *   npx tsx backend/scripts/provision-tenant-maps.ts
 *
 * Required (read from backend/.env):
 *   - T3N_API_KEY      T3N API key for your tenant
 *   - T3_TENANT_DID    The tenant DID T3N issued you
 * Optional:
 *   - T3N_ENV          "testnet" (default) or "production"
 *   - T3_NETWORK_URL   Override the testnet URL
 */
import { existsSync, readFileSync } from "node:fs";
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
  SealedSecretMapProvisioner,
} from "../src/enclave/keys/sealed-secret-maps.js";
import type { T3NetworkClient } from "../src/enclave/sandbox/t3n-client.js";

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

  if (!apiKey) {
    throw new Error("T3N_API_KEY is missing from backend/.env");
  }
  if (!configuredTenantDid) {
    throw new Error("T3_TENANT_DID is missing from backend/.env");
  }

  console.log("── Provisioning tenant kv-store maps ──");
  console.log(`  T3N_API_KEY    = ${maskKey(apiKey)}`);
  console.log(`  T3N_ENV        = ${networkEnv}`);
  console.log(`  T3_TENANT_DID  = ${configuredTenantDid}`);
  console.log();

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
    process.exit(1);
  }

  if (!tenantDid.startsWith("did:t3n:")) {
    console.error(`✗ T3N returned a non-DID tenant identifier: ${tenantDid}`);
    process.exit(1);
  }

  console.log(`✓ authenticated as tenant ${tenantDid}`);
  console.log();

  // Build a minimal T3NetworkClient adapter that routes
  // /tenant/maps POSTs to tenant.maps.create(). The
  // SdkAuthenticatedT3NetworkClient already does this, but
  // constructing it requires the full composition root. Instead
  // we build a thin adapter that delegates to the TenantClient
  // directly — the SealedSecretMapProvisioner only calls
  // POST /tenant/maps.
  const tenant = new TenantClient({
    environment: networkEnv as "testnet" | "production",
    endpoint: baseUrl,
    baseUrl,
    tenantDid,
    t3n,
  });

  const networkClient: T3NetworkClient = {
    async request(req) {
      if (req.path === "/tenant/maps" && req.method === "POST") {
        const body = req.body as {
          tail?: string;
          visibility?: string;
          writers?: readonly string[];
          readers?: readonly string[];
          acl?: { readers?: readonly string[]; writers?: readonly string[] };
        } | undefined;
        const tail = body?.tail;
        if (typeof tail !== "string" || tail.length === 0) {
          throw new Error("tenant/maps request missing map tail.");
        }
        const writerIds = (body?.writers ?? body?.acl?.writers ?? [])
          .map((w) => Number(w))
          .filter((n) => Number.isFinite(n));
        const readerIds = (body?.readers ?? body?.acl?.readers ?? [])
          .map((r) => Number(r))
          .filter((n) => Number.isFinite(n));
        const result = await tenant.maps.create({
          tail,
          visibility: body?.visibility ?? "private",
          writers: writerIds.length > 0 ? { Only: writerIds } : "All",
          ...(readerIds.length > 0
            ? { readers: { Only: readerIds } }
            : {}),
        });
        return { status: 200, body: result as never };
      }
      return { status: 503, body: { code: "unsupported" } as never };
    },
  };

  const provisioner = new SealedSecretMapProvisioner(networkClient);

  const maps = ["intents", "rounds"] as const;
  for (const tail of maps) {
    try {
      const result = await provisioner.provision({
        tenantDid,
        tail,
        readers: [tenantDid],
        writers: [tenantDid],
      });
      if (result.status === "created") {
        console.log(`✓ provisioned map "${tail}"`);
      } else {
        console.log(`✓ map "${tail}" already exists`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already[_ -]exists|already[_ -]registered|conflict/i.test(message)) {
        console.log(`✓ map "${tail}" already exists`);
        continue;
      }
      console.error(`✗ Failed to provision map "${tail}": ${message}`);
      process.exit(2);
    }
  }

  console.log();
  console.log("── Done ──");
  console.log("  The v0.10.0 matching contract can now persist");
  console.log("  decrypted price/quantity into the enclave's kv-store.");
  console.log();
  console.log("  Next steps:");
  console.log("    1. Publish the matching contract (if not already done):");
  console.log("       npx tsx backend/scripts/publish-matching.ts");
  console.log("    2. Restart the backend: npm run dev:backend");
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
