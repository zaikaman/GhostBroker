import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
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

function hashApiKey(key: string, secret: string): { keyBcrypt: string; lookupKey: string } {
  const keyBcrypt = bcrypt.hashSync(key, 12);
  const lookupKey = createHmac("sha256", secret).update(key).digest("hex");
  return { keyBcrypt, lookupKey };
}

async function main() {
  const env = loadBackendEnv(BACKEND_ENV_PATH);
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const authSessionSecret = env.AUTH_SESSION_SECRET;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  }
  if (!authSessionSecret) {
    throw new Error("Missing AUTH_SESSION_SECRET in backend/.env; required to derive api_keys.lookup_key");
  }

  console.log("Connecting to Supabase...");
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const buyerInstId = "00000000-0000-4000-8000-0000000007a1";
  const sellerInstId = "00000000-0000-4000-8000-0000000007a2";

  const buyerKey = "gbk_DnOR8QnB_DnOR8QnBra5M5dUjnG_j2vxDyH6ILQspjIfnYwhD0GU";
  const sellerKey = "gbk_RfylFnE0_RfylFnE0bVwn0bKgcapeeu8zmq02XGMmM5gFc1j15js";

  console.log("Cleaning existing API keys for test institutions...");
  await supabase.from("api_keys").delete().in("institution_id", [buyerInstId, sellerInstId]);

  console.log("Cleaning existing portfolios for test institutions...");
  await supabase.from("portfolios").delete().in("institution_id", [buyerInstId, sellerInstId]);

  console.log("Upserting institutions...");
  const institutions = [
    {
      id: buyerInstId,
      legal_name: "Institution Buyer (E2E Test)",
      display_name: "Institution Buyer",
      status: "active",
      t3_tenant_did: "did:t3:buyer-institution-test",
      settlement_profile_ref: "chain:sepolia:erc20",
      metadata: { type: "e2e_test_agent" }
    },
    {
      id: sellerInstId,
      legal_name: "Institution Seller (E2E Test)",
      display_name: "Institution Seller",
      status: "active",
      t3_tenant_did: "did:t3:seller-institution-test",
      settlement_profile_ref: "chain:sepolia:erc20",
      metadata: { type: "e2e_test_agent" }
    }
  ];

  for (const inst of institutions) {
    const { error } = await supabase.from("institutions").upsert(inst);
    if (error) {
      console.error(`Error upserting institution ${inst.display_name}:`, error);
      process.exit(1);
    }
    console.log(`✓ Institution ${inst.display_name} upserted.`);
  }

  console.log("Creating portfolios & balances...");
  const portfolios = [
    // Buyer has USDC cash
    {
      institution_id: buyerInstId,
      asset_code: "USDC",
      balance: 1000000.0,
      locked: 0.0
    },
    {
      institution_id: buyerInstId,
      asset_code: "WBTC",
      balance: 0.0,
      locked: 0.0
    },
    // Seller has WBTC asset
    {
      institution_id: sellerInstId,
      asset_code: "USDC",
      balance: 0.0,
      locked: 0.0
    },
    {
      institution_id: sellerInstId,
      asset_code: "WBTC",
      balance: 10.0,
      locked: 0.0
    }
  ];

  for (const port of portfolios) {
    const { error } = await supabase.from("portfolios").upsert(port);
    if (error) {
      console.error(`Error creating portfolio for ${port.institution_id} / ${port.asset_code}:`, error);
      process.exit(1);
    }
    console.log(`✓ Portfolio for ${port.institution_id} (${port.asset_code}) created.`);
  }

  console.log("Seeding API keys...");
  const buyerHash = hashApiKey(buyerKey, authSessionSecret);
  const sellerHash = hashApiKey(sellerKey, authSessionSecret);
  const apiKeys = [
    {
      institution_id: buyerInstId,
      label: "e2e-buyer-key",
      prefix: "DnOR8QnB",
      key_bcrypt: buyerHash.keyBcrypt,
      lookup_key: buyerHash.lookupKey,
      scopes: "agent:operate"
    },
    {
      institution_id: sellerInstId,
      label: "e2e-seller-key",
      prefix: "RfylFnE0",
      key_bcrypt: sellerHash.keyBcrypt,
      lookup_key: sellerHash.lookupKey,
      scopes: "agent:operate"
    }
  ];

  for (const key of apiKeys) {
    const { error } = await supabase.from("api_keys").upsert(key);
    if (error) {
      console.error(`Error seeding API key ${key.label}:`, error);
      process.exit(1);
    }
    console.log(`✓ API key ${key.label} seeded.`);
  }

  console.log("\nSetup complete! The institutions, portfolios, and API keys are successfully seeded in the database.");
}

main().catch((err) => {
  console.error("Fatal seeding error:", err);
  process.exit(1);
});
