#!/usr/bin/env node
/**
 * Verify the published `matching` TEE contract responds correctly.
 *
 * Calls the four contract exports end-to-end against the live
 * tenant contract and prints the handles / refs the T3N
 * tenant returns. Covers:
 *   1. `seal-intent`             — opaque handle for a blind intent
 *   2. `evaluate-match` (cross)  — matched with a deterministic fill
 *   3. `evaluate-match` (frac)   — sub-unit fill (0.0001 WBTC) which
 *                                  the pre-v0.4.0 contract silently
 *                                  turned into `no_match`
 *   4. `evaluate-match` (nocross)— no_match with empty fill fields
 *   5. `seal-ticket`             — opaque handle bound to
 *                                  `policy_hash` and
 *                                  `compatibility_token` (the v0.6.0
 *                                  fix — older contracts reserved
 *                                  capacity for these fields but
 *                                  never wrote the bytes)
 *   6. `evaluate-pair` (compat)  — `status: "compatible"` on a real
 *                                  two-sided ticket pair
 *   7. `evaluate-pair` (reject)  — `status: "incompatible"` with a
 *                                  stable `reason_code` on a pair
 *                                  that violates the structural axes
 *                                  (same institution)
 *
 * If any call returns `not_found` or `bad_request`, the published
 * contract is the wrong version or the T3N session is stale.
 *
 * Run from the workspace root:
 *   npm run contract:verify:matching -w @ghostbroker/backend
 *
 * Or directly:
 *   npx tsx backend/scripts/verify-matching-contract.ts
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

async function main(): Promise<void> {
  const env = loadBackendEnv(BACKEND_ENV_PATH);
  const apiKey = env.T3N_API_KEY;
  const networkEnv = env.T3N_ENV ?? "testnet";
  const networkUrl = env.T3_NETWORK_URL;
  const version = env.T3_MATCHING_CONTRACT_VERSION ?? "0.10.1";
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
  // = 50000. Prices and quantities travel as fractional decimal
  // strings at the contract's implicit 1e18 scale (see
  // `WIRE_SCALE` in backend/contracts/matching-policy/src/matching.rs);
  // the orchestrator's `decimalString` keeps the wire form
  // human-readable (`"0.0001"`, `"70000"`) so the settlement rail
  // can consume it directly via `parseUnits(qty.toString(), 8)`.
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

  // Call evaluate-match with a CROSSING pair at a sub-unit fill
  // (0.0001 WBTC) — this is the case the previous (0.3.0 / 0.2.0)
  // contracts silently turned into `no_match` because the wire
  // form was integer-only. v0.4.0 must return `matched` with
  // `matched_quantity = "0.0001"` and `execution_price = "50000"`.
  const fractionalInput = {
    buy_intent_handle: "intent_verify_buy_frac",
    sell_intent_handle: "intent_verify_sell_frac",
    correlation_ref: "verify-match-frac-" + Date.now(),
    asset_code: "WBTC",
    buy_price: "51000",
    buy_quantity: "0.0001",
    sell_price: "49000",
    sell_quantity: "0.0001",
  };

  console.log("→ calling evaluate-match (fractional 0.0001 WBTC cross)...");
  const fractionalResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "evaluate-match",
      input: { input: JSON.stringify(fractionalInput) },
    })
    .catch((err: unknown) => {
      console.error(
        `✗ evaluate-match (fractional) FAILED: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  if (fractionalResult) {
    console.log(
      "✓ evaluate-match (fractional) response:",
      JSON.stringify(fractionalResult, null, 2),
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

  // Call seal-ticket. v0.6.0 binds `policy_hash` and
  // `compatibility_token` into the handle, so the v0.4.0 build
  // returns a DIFFERENT handle for the same input. We pass
  // distinct correlation refs for buy/sell so the handles don't
  // collide on the v0.4.0 contract (where the correlation_ref
  // is the only field that distinguishes them).
  const sealTicketInput = {
    institution_id: "ec27760a-bec2-4924-b7c3-7e358547bf83",
    agent_did: "did:t3n:demo-verify-ticket",
    authority_ref: "ghostbroker-delegation:verify-test",
    asset_code: "WBTC",
    side: "buy",
    policy_hash: "verify-policy-hash-0001",
    compatibility_token: "WBTC:buy:ec27760a-bec2-4924-b7c3-7e358547bf83",
    correlation_ref: "verify-ticket-buyer-" + Date.now(),
  };

  console.log("→ calling seal-ticket...");
  const sealTicketResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "seal-ticket",
      input: { input: JSON.stringify(sealTicketInput) },
    })
    .catch((err: unknown) => {
      console.error(`✗ seal-ticket FAILED: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  if (sealTicketResult) {
    console.log(
      "✓ seal-ticket response:",
      JSON.stringify(sealTicketResult, null, 2),
    );
  }

  console.log();

  // Call evaluate-pair (compatible). Two sealed tickets from
  // different institutions on opposite sides of the same asset
  // should return `status: "compatible"`. We use the sealTicket
  // response above (so the buy handle is the live TEE-issued
  // handle) and seal a sell ticket below for the counterpart.
  const sellTicketInput = {
    institution_id: "11111111-2222-3333-4444-555555555555",
    agent_did: "did:t3n:demo-verify-ticket-seller",
    authority_ref: "ghostbroker-delegation:verify-test-seller",
    asset_code: "WBTC",
    side: "sell",
    policy_hash: "verify-policy-hash-0002",
    compatibility_token: "WBTC:sell:11111111-2222-3333-4444-555555555555",
    correlation_ref: "verify-ticket-seller-" + Date.now(),
  };

  console.log("→ calling seal-ticket (sell side)...");
  const sellTicketResult = await tenant.contracts
    .execute("matching", {
      version,
      functionName: "seal-ticket",
      input: { input: JSON.stringify(sellTicketInput) },
    })
    .catch((err: unknown) => {
      console.error(
        `✗ seal-ticket (sell) FAILED: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
  if (sellTicketResult) {
    console.log(
      "✓ seal-ticket (sell) response:",
      JSON.stringify(sellTicketResult, null, 2),
    );
  }

  // Build the evaluate-pair (compatible) request from the two
  // seal responses. The contract doesn't keep state between
  // calls, so the orchestrator is responsible for handing back
  // the exact handles the seal calls returned; the TEE then
  // re-parses the compatibility tokens and validates every
  // structural axis.
  const buyTicketHandle = (sealTicketResult as { ticket_handle?: string } | null)
    ?.ticket_handle;
  const sellTicketHandle = (sellTicketResult as { ticket_handle?: string } | null)
    ?.ticket_handle;
  if (buyTicketHandle && sellTicketHandle) {
    const pairCompatibleInput = {
      buy_ticket_handle: buyTicketHandle,
      sell_ticket_handle: sellTicketHandle,
      buy_compatibility_token: sealTicketInput.compatibility_token,
      sell_compatibility_token: sellTicketInput.compatibility_token,
      asset_code: "WBTC",
      correlation_ref: "verify-pair-compat-" + Date.now(),
    };

    console.log("→ calling evaluate-pair (compatible)...");
    const pairCompatibleResult = await tenant.contracts
      .execute("matching", {
        version,
        functionName: "evaluate-pair",
        input: { input: JSON.stringify(pairCompatibleInput) },
      })
      .catch((err: unknown) => {
        console.error(
          `✗ evaluate-pair (compatible) FAILED: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
    if (pairCompatibleResult) {
      console.log(
        "✓ evaluate-pair (compatible) response:",
        JSON.stringify(pairCompatibleResult, null, 2),
      );
    }

    // Same handles, but use the BUYER's compatibility token on
    // BOTH sides — that violates the `same institution` rule
    // (both tokens reference the same institution id) and the
    // TEE must return `status: "incompatible"` with
    // `reason_code: "same_institution"`.
    const pairRejectInput = {
      buy_ticket_handle: buyTicketHandle,
      sell_ticket_handle: sellTicketHandle,
      buy_compatibility_token: sealTicketInput.compatibility_token,
      sell_compatibility_token: sealTicketInput.compatibility_token,
      asset_code: "WBTC",
      correlation_ref: "verify-pair-reject-" + Date.now(),
    };

    console.log("→ calling evaluate-pair (incompatible, same institution)...");
    const pairRejectResult = await tenant.contracts
      .execute("matching", {
        version,
        functionName: "evaluate-pair",
        input: { input: JSON.stringify(pairRejectInput) },
      })
      .catch((err: unknown) => {
        console.error(
          `✗ evaluate-pair (incompatible) FAILED: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
    if (pairRejectResult) {
      console.log(
        "✓ evaluate-pair (incompatible) response:",
        JSON.stringify(pairRejectResult, null, 2),
      );
    }
  } else {
    console.log(
      "  (skipping evaluate-pair probes — one or both seal-ticket calls did not return a handle)",
    );
  }

  console.log();
  console.log("── Done ──");
  console.log("If all probes above returned opaque handles / refs, the");
  console.log("v0.6.0 contract is live and the orchestrator's pair gate");
  console.log("(`evaluate-pair`) is the actual matching authority.");
  console.log("Restart the backend (`npm run dev` in backend/) so the");
  console.log("T3 client picks up the new contract registration.");
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(99);
});
