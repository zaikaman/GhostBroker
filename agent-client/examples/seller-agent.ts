#!/usr/bin/env node
/**
 * GhostBroker Seller Agent — runnable end-to-end example.
 *
 * What it does:
 *   1. Exchanges the API key for an 8-hour session.
 *   2. Builds a delegation proof and admits the agent.
 *   3. Submits an encrypted sell intent.
 *   4. Polls /api/trades/completed every 5 seconds and prints the
 *      most recent settlement, then fetches and prints the audit receipt.
 *
 * Usage:
 *   cp .env.example .env       # then edit
 *   npx tsx examples/seller-agent.ts
 *
 * Or with env vars inline — see buyer-agent.ts for the full list.
 *
 * To stop the example, press Ctrl+C once.
 */

import { GhostBrokerClient, DelegationProofBuilder, GhostBrokerApiError } from "../src/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Helpers (shared with buyer-agent.ts; copy-pasted to keep the example
//    runnable without a build step) ──────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`✗ Missing required env var: ${name}`);
    console.error("  Copy .env.example to .env and fill it in, or pass it inline.");
    process.exit(1);
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    console.error(`✗ Expected a 32-byte hex private key, got: ${hex.slice(0, 12)}…`);
    process.exit(1);
  }
  return new Uint8Array(Buffer.from(cleaned, "hex"));
}

function loadDotEnv(path: string): void {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));
loadDotEnv(resolve(import.meta.dirname, "..", ".env"));

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseUrl = requireEnv("GHOSTBROKER_URL");
  const apiKey = requireEnv("GHOSTBROKER_API_KEY");
  const agentDid = requireEnv("AGENT_DID");
  // INSTITUTION_ID is intentionally not read here: the authenticated
  // session exposes the canonical institution id via `session.institution.id`,
  // which is what we wire into every proof and request below.
  const policyHash = requireEnv("POLICY_HASH");
  const credentialJcsBase64 = requireEnv("CREDENTIAL_JCS_BASE64");
  const adminPrivateKey = hexToBytes(requireEnv("ADMIN_PRIVATE_KEY"));
  const agentPrivateKey = hexToBytes(requireEnv("AGENT_PRIVATE_KEY"));
  const encryptedIntentEnvelope = requireEnv("ENCRYPTED_INTENT_ENVELOPE");

  console.log("→ Connecting to", baseUrl);

  // 1. Authenticate
  const client = new GhostBrokerClient({ baseUrl });
  const session = await client.authenticateWithApiKey(apiKey);
  console.log(`✓ Authenticated as ${session.institution.displayName} (${session.institution.id})`);

  // 2. Admit
  console.log("→ Building delegation proof and admitting agent…");
  const proof = await DelegationProofBuilder.build({
    institutionId: session.institution.id,
    agentDid,
    requestedAction: "agent.admit",
    policyHash,
    credentialJcsBase64,
    adminPrivateKey,
    agentPrivateKey,
  });
  const admission = await client.admitAgent({
    institutionId: session.institution.id,
    agentDid,
    authorityProof: DelegationProofBuilder.serialize(proof),
  });
  console.log(`✓ Admitted. Authority ref: ${admission.authorityRef}`);

  // 3. Submit intent
  console.log("→ Submitting encrypted sell intent…");
  try {
    const intent = await client.submitIntent({
      institutionId: session.institution.id,
      agentDid,
      encryptedIntentEnvelope,
      authorityRef: admission.authorityRef,
    });
    console.log(`✓ Intent sealed: ${intent.intentHandle}`);
  } catch (err) {
    if (err instanceof GhostBrokerApiError && err.status === 403) {
      console.error("✗ Admission rejected by the enclave.");
    }
    throw err;
  }

  // 4. Poll for completed trades
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const durationArg = process.argv.find((arg) => arg.startsWith("--duration="));
  const durationSeconds = durationArg ? Number(durationArg.split("=")[1]) : 60;
  const deadline = Date.now() + durationSeconds * 1000;
  let stopPolling = false;

  console.log(`→ Polling /api/trades/completed every ${pollIntervalMs}ms for up to ${durationSeconds}s.`);

  process.on("SIGINT", () => {
    console.log("\n→ Caught SIGINT, stopping poll…");
    stopPolling = true;
  });
  process.on("SIGTERM", () => {
    stopPolling = true;
  });

  let lastTradeCount = 0;
  while (!stopPolling && Date.now() < deadline) {
    try {
      const { items } = await client.getCompletedTrades();
      if (items.length > lastTradeCount) {
        const newest = items[0];
        console.log(
          `✓ New completed trade: ${newest.tradeRef} @ ${newest.settledAt} [${newest.settlementStatus}]`,
        );
        if (newest.receiptIds.length > 0) {
          const receipt = await client.getReceipt(newest.receiptIds[0]);
          console.log(`  Receipt ${receipt.id}`);
          console.log(`    Hash:        ${receipt.receiptHash}`);
          console.log(`    Key version: ${receipt.keyVersion}`);
          console.log(`    Attestation: ${receipt.t3AttestationRef}`);
        }
        lastTradeCount = items.length;
        // One trade per run is enough for the example; exit early.
        break;
      }
    } catch (err) {
      if (err instanceof GhostBrokerApiError && err.isAuthError) {
        console.error("✗ Session expired. Re-authenticating…");
        await client.authenticateWithApiKey(apiKey);
        continue;
      }
      console.error("⚠ Poll error:", err);
    }
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }

  console.log("→ Done.");
}

main().catch((err) => {
  if (err instanceof GhostBrokerApiError) {
    console.error(
      `✗ GhostBroker API error [${err.status} ${err.code}]: ${err.message}`,
    );
  } else if (err instanceof Error) {
    console.error(`✗ ${err.name}: ${err.message}`);
  } else {
    console.error("✗ Unexpected error:", err);
  }
  process.exit(1);
});
