#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent Example
 *
 * This script demonstrates how an institution's autonomous agent
 * connects to GhostBroker, authenticates with an API key, submits a
 * buy intent, and monitors for settlement via WebSocket telemetry.
 *
 * Prerequisites:
 *   - A GhostBroker API key (generate one from the API Keys panel on
 *     the dashboard).
 *
 * Usage:
 *   export GHOSTBROKER_URL=http://localhost:3001
 *   export GHOSTBROKER_API_KEY=gbk_...
 *   export ADMIN_PRIVATE_KEY=0x...
 *   export AGENT_PRIVATE_KEY=0x...
 *   export CREDENTIAL_JCS_BASE64=...
 *   export ENCRYPTED_INTENT_ENVELOPE=...
 *   npx tsx examples/agent-buyer.ts
 */

import { GhostBrokerClient, DelegationProofBuilder } from "../agent-client/src/index.js";

const GHOSTBROKER_URL = process.env.GHOSTBROKER_URL || "http://localhost:3001";
const GHOSTBROKER_API_KEY = process.env.GHOSTBROKER_API_KEY;
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const CREDENTIAL_JCS = process.env.CREDENTIAL_JCS_BASE64;
const ENCRYPTED_INTENT = process.env.ENCRYPTED_INTENT_ENVELOPE;

async function main(): Promise<void> {
  if (!GHOSTBROKER_API_KEY || !ADMIN_PRIVATE_KEY || !AGENT_PRIVATE_KEY) {
    console.error(
      "Missing required env vars: GHOSTBROKER_API_KEY, ADMIN_PRIVATE_KEY, AGENT_PRIVATE_KEY",
    );
    process.exit(1);
  }

  const adminKey = new Uint8Array(Buffer.from(ADMIN_PRIVATE_KEY.replace(/^0x/, ""), "hex"));
  const agentKey = new Uint8Array(Buffer.from(AGENT_PRIVATE_KEY.replace(/^0x/, ""), "hex"));

  // Initialize the unified GhostBroker client
  const client = new GhostBrokerClient({ baseUrl: GHOSTBROKER_URL });

  // Step 1: Authenticate by exchanging the API key for an 8-hour session.
  // The SDK also wires the institution ID into the telemetry WebSocket filter.
  console.log("[Buyer Agent] Authenticating with GhostBroker...");
  const session = await client.authenticateWithApiKey(GHOSTBROKER_API_KEY);
  console.log(`[Buyer Agent] Authenticated! Institution: ${session.institution.displayName}`);
  console.log(`[Buyer Agent] Telemetry now scoped to institution: ${session.institution.id}`);

  // Step 2: Build delegation proof and admit the agent
  if (CREDENTIAL_JCS) {
    console.log("[Buyer Agent] Building delegation proof...");
    const proof = await DelegationProofBuilder.build({
      institutionId: session.institution.id,
      agentDid: "did:t3n:0xBuyerAgentAddress",
      requestedAction: "agent.admit",
      policyHash: "sha256:policy-hash-here",
      credentialJcsBase64: CREDENTIAL_JCS,
      adminPrivateKey: adminKey,
      agentPrivateKey: agentKey,
    });

    console.log("[Buyer Agent] Admitting agent...");
    const admission = await client.admitAgent({
      institutionId: session.institution.id,
      agentDid: "did:t3n:0xBuyerAgentAddress",
      authorityProof: DelegationProofBuilder.serialize(proof),
    });
    console.log(`[Buyer Agent] Admitted! Authority Ref: ${admission.authorityRef}`);

    // Step 3: Submit a buy intent
    if (ENCRYPTED_INTENT) {
      console.log("[Buyer Agent] Submitting buy intent...");
      const intent = await client.submitIntent({
        institutionId: session.institution.id,
        agentDid: "did:t3n:0xBuyerAgentAddress",
        encryptedIntentEnvelope: ENCRYPTED_INTENT,
        authorityRef: admission.authorityRef,
      });
      console.log(`[Buyer Agent] Intent submitted! Handle: ${intent.intentHandle}`);

      // Step 4: Listen for settlement via WebSocket telemetry
      // The telemetry client is automatically scoped to your institution after authenticateWithApiKey()
      console.log("[Buyer Agent] Listening for settlement events (WebSocket)...");
      client.telemetry.onSettled((correlationRef) => {
        console.log(`[Buyer Agent] Settlement detected! Ref: ${correlationRef}`);
        client.getCompletedTrades().then((trades) => {
          console.log(`[Buyer Agent] Completed trades: ${trades.items.length}`);
          trades.items.forEach((trade) => {
            console.log(`  - ${trade.tradeRef} at ${trade.settledAt} [${trade.settlementStatus}]`);
          });
        });
      });

      client.telemetry.onError((phase, correlationRef) => {
        console.log(`[Buyer Agent] Settlement error: ${phase} (ref: ${correlationRef})`);
      });

      client.telemetry.connect();
      console.log("[Buyer Agent] Telemetry connected. Waiting for settlement...");

      // Run for 60 seconds max, then clean up
      await new Promise((resolve) => setTimeout(resolve, 60000));
      client.telemetry.disconnect();
    }
  }

  console.log("[Buyer Agent] Done.");
}

main().catch(console.error);
