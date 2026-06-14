#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent — runnable end-to-end example.
 *
 * What it does:
 *   1. Exchanges the API key for an 8-hour session.
 *   2. Builds a delegation proof and admits the agent.
 *   3. Submits an encrypted buy intent.
 *   4. Listens for settlement on the telemetry WebSocket and prints
 *      each completed trade as it arrives.
 *
 * Usage:
 *   # 1. Copy the env template and fill it in
 *   cp .env.example .env
 *   # 2. Edit .env with your real API key, keys, credential, envelope
 *   # 3. Run
 *   npx tsx examples/buyer-agent.ts
 *
 * Or, with env vars inline:
 *   GHOSTBROKER_URL=http://localhost:3001 \
 *   GHOSTBROKER_API_KEY=*** \
 *   AGENT_DID=did:t3n:0xYourAgentAddress \
 *   INSTITUTION_ID=00000000-0000-4000-8000-000000000000 \
 *   POLICY_HASH=sha256:abc... \
 *   CREDENTIAL_JCS_BASE64=*** \
 *   ADMIN_PRIVATE_KEY=0x0000...0000 \
 *   AGENT_PRIVATE_KEY=0x0000...0000 \
 *   ENCRYPTED_INTENT_ENVELOPE=... \
 *   npx tsx examples/buyer-agent.ts
 *
 * To stop the example cleanly, press Ctrl+C once. The WebSocket will
 * disconnect and the process will exit.
 */

import { GhostBrokerClient, DelegationProofBuilder, GhostBrokerApiError } from "../src/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────────

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
    console.error(`✗ Expected a 32-byte hex private key (with or without 0x prefix), got: ${hex.slice(0, 12)}…`);
    process.exit(1);
  }
  return new Uint8Array(Buffer.from(cleaned, "hex"));
}

function loadDotEnv(path: string): void {
  // Minimal .env loader so the example works with `npx tsx examples/...` without dotenv.
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

// Load .env from CWD if present, then from the agent-client folder as a fallback.
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
  console.log("→ Submitting encrypted buy intent…");
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
      console.error("  Check that your delegation credential is valid and matches the agent key.");
    }
    throw err;
  }

  // 4. Listen for settlement
  console.log("→ Connecting to telemetry. Waiting for settlement…");
  const unsubscribe = client.telemetry.onSettled(async (correlationRef) => {
    console.log(`✓ Settlement finalized: ${correlationRef}`);
    try {
      const { items } = await client.getCompletedTrades();
      console.log(`  Completed trades for institution: ${items.length}`);
      for (const trade of items.slice(0, 5)) {
        console.log(`    - ${trade.tradeRef} @ ${trade.settledAt} [${trade.settlementStatus}]`);
      }
    } catch (err) {
      console.error("  Failed to fetch completed trades:", err);
    }
  });

  client.telemetry.onError((phase, correlationRef) => {
    console.error(`⚠ Telemetry error: ${phase} (ref: ${correlationRef})`);
  });

  const stopStatus = client.telemetry.onStatusChange((status) => {
    console.log(`  Telemetry status: ${status}`);
  });

  client.telemetry.connect();

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal: string) => {
    console.log(`\n→ Caught ${signal}, shutting down…`);
    unsubscribe();
    stopStatus();
    client.telemetry.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Run for 60 seconds by default, or until --duration=Ns is passed
  const durationArg = process.argv.find((arg) => arg.startsWith("--duration="));
  const durationSeconds = durationArg ? Number(durationArg.split("=")[1]) : 60;
  console.log(`  Will exit after ${durationSeconds}s (override with --duration=N).`);

  await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, durationSeconds * 1000));
  shutdown("timeout");
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
