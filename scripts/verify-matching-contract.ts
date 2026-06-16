#!/usr/bin/env node
/**
 * Verify the published `matching` TEE contract responds correctly.
 *
 * Calls `seal-intent` and `evaluate-match` against the live
 * tenant contract and prints the handles / outcome refs the
 * T3N tenant returns. If the contract is missing or broken,
 * the call surfaces a T3N error (no more silent 400 from the
 * orchestrator route).
 *
 * Run from the workspace root:
 *   npx tsx scripts/verify-matching-contract.ts
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

async function main(): Promise<void> {
  const env = loadBackendEnv(BACKEND_ENV_PATH);
  const apiKey = env.T3N_API_KEY;
  const networkEnv = env.T3N_ENV ?? "testnet";
  const networkUrl = env.T3_NETWORK_URL;
  const version = env.T3_MATCHING_CONTRACT_VERSION ?? "0.2.0";
  if (!apiKey) {
    throw new Error("T3N_API_KEY is missing from backend/.env");
  }

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
  await t3n.handshake();
  const tenantDid = (await t3n.authenticate(createEthAuthInput(address))).value;
  const tenant = new TenantClient({
    environment: networkEnv as "testnet" | "production",
    endpoint: baseUrl,
    baseUrl,
    tenantDid,
    t3n,
  });

  console.log(`── Verifying matching contract v${version} on tenant ${tenantDid} ──\n`);

  // Call seal-intent.
  const sealInput = {
    institution_id: "ec27760a-bec2-4924-b7c3-7e358547bf83",
    agent_did: "did:t3n:demo-verify-test",
    encrypted_intent: "verify-envelope-base64url-placeholder",
    authority_ref: "ghostbroker-delegation:verify-test",
    correlation_ref: "verify-corr-" + Date.now(),
  };

  console.log("→ calling seal-intent...");
  const sealResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "seal-intent",
      input: { input: JSON.stringify(sealInput) },
    })
    .catch((err: unknown) => {
      console.error(`✗ seal-intent FAILED: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  if (sealResult) {
    console.log("✓ seal-intent response:", JSON.stringify(sealResult, null, 2));
  }

  console.log();

  // Call evaluate-match with a CROSSING pair: buyer bids 51000,
  // seller asks 49000 → the enclave should return `matched` with
  // matched_quantity = min(10, 4) = 4 and execution_price = midpoint
  // = 50000. Prices and quantities travel as decimal strings for
  // exact integer transport (see contracts/matching-policy/
  // src/matching.rs).
  const crossInput = {
    buy_intent_handle: "intent_verify_buy_abc",
    sell_intent_handle: "intent_verify_sell_def",
    correlation_ref: "verify-match-cross-" + Date.now(),
    asset_code: "WBTC",
    buy_price: "51000",
    buy_quantity: "10",
    sell_price: "49000",
    sell_quantity: "4",
  };

  console.log("→ calling evaluate-match (crossing pair)...");
  const crossResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "evaluate-match",
      input: { input: JSON.stringify(crossInput) },
    })
    .catch((err: unknown) => {
      console.error(
        `✗ evaluate-match (cross) FAILED: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  if (crossResult) {
    console.log(
      "✓ evaluate-match (cross) response:",
      JSON.stringify(crossResult, null, 2),
    );
  }

  console.log();

  // Call evaluate-match with a NON-CROSSING pair: buyer bids 40000,
  // seller asks 50000 → the enclave should return `no_match` with
  // empty fill fields.
  const noCrossInput = {
    buy_intent_handle: "intent_verify_buy_nox",
    sell_intent_handle: "intent_verify_sell_nox",
    correlation_ref: "verify-match-nocross-" + Date.now(),
    asset_code: "WBTC",
    buy_price: "40000",
    buy_quantity: "10",
    sell_price: "50000",
    sell_quantity: "10",
  };

  console.log("→ calling evaluate-match (non-crossing pair)...");
  const noCrossResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "evaluate-match",
      input: { input: JSON.stringify(noCrossInput) },
    })
    .catch((err: unknown) => {
      console.error(
        `✗ evaluate-match (no-cross) FAILED: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  if (noCrossResult) {
    console.log(
      "✓ evaluate-match (no-cross) response:",
      JSON.stringify(noCrossResult, null, 2),
    );
  }


  console.log();
  console.log("── Done ──");
  console.log("If both calls above returned opaque handles / refs, the");
  console.log("contract is live and the orchestrator's 404 is gone.");
  console.log("Restart the backend (`npm run dev` in backend/) so the");
  console.log("T3 client picks up the new contract registration.");
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
