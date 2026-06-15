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

  console.log(`── Verifying matching contract on tenant ${tenantDid} ──\n`);

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
      version: "0.1.0",
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

  // Call evaluate-match.
  const matchInput = {
    buy_intent_handle: "intent_verify_buy_abc",
    sell_intent_handle: "intent_verify_sell_def",
    correlation_ref: "verify-match-corr-" + Date.now(),
  };

  console.log("→ calling evaluate-match...");
  const matchResult = await tenant.contracts
    .execute("matching", {
      version: "0.1.0",
      functionName: "evaluate-match",
      input: { input: JSON.stringify(matchInput) },
    })
    .catch((err: unknown) => {
      console.error(
        `✗ evaluate-match FAILED: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  if (matchResult) {
    console.log(
      "✓ evaluate-match response:",
      JSON.stringify(matchResult, null, 2),
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
