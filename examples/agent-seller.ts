#!/usr/bin/env node
/**
 * GhostBroker Seller Agent Example
 *
 * This script demonstrates how an institution's autonomous agent
 * connects to GhostBroker, authenticates with an API key, submits a
 * sell intent, and monitors for settlement via polling.
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
 *   npx tsx examples/agent-seller.ts
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
  console.log("[Seller Agent] Authenticating with GhostBroker...");
  const session = await client.authenticateWithApiKey(GHOSTBROKER_API_KEY);
  console.log(`[Seller Agent] Authenticated! Institution: ${session.institution.displayName}`);

  // Step 2: Build delegation proof and admit the agent
  if (CREDENTIAL_JCS) {
    console.log("[Seller Agent] Building delegation proof...");
    const proof = await DelegationProofBuilder.build({
      institutionId: session.institution.id,
      agentDid: "did:t3n:0xSellerAgentAddress",
      requestedAction: "agent.admit",
      policyHash: "sha256:policy-hash-here",
      credentialJcsBase64: CREDENTIAL_JCS,
      adminPrivateKey: adminKey,
      agentPrivateKey: agentKey,
    });

    console.log("[Seller Agent] Admitting agent...");
    const admission = await client.admitAgent({
      institutionId: session.institution.id,
      agentDid: "did:t3n:0xSellerAgentAddress",
      authorityProof: DelegationProofBuilder.serialize(proof),
    });
    console.log(`[Seller Agent] Admitted! Authority Ref: ${admission.authorityRef}`);

    // Step 3: Submit a sell intent
    if (ENCRYPTED_INTENT) {
      console.log("[Seller Agent] Submitting sell intent...");
      const intent = await client.submitIntent({
        institutionId: session.institution.id,
        agentDid: "did:t3n:0xSellerAgentAddress",
        encryptedIntentEnvelope: ENCRYPTED_INTENT,
        authorityRef: admission.authorityRef,
      });
      console.log(`[Seller Agent] Intent submitted! Handle: ${intent.intentHandle}`);

      // Step 4: Monitor for settlement via polling
      console.log("[Seller Agent] Polling for settlement (every 5s)...");
      const pollInterval = setInterval(async () => {
        try {
          const trades = await client.getCompletedTrades();
          if (trades.items.length > 0) {
            const latest = trades.items[0];
            console.log(`[Seller Agent] Trade found! ${latest.tradeRef} - ${latest.settlementStatus}`);
            clearInterval(pollInterval);

            // Step 5: Retrieve the receipt
            if (latest.receiptIds.length > 0) {
              const receipt = await client.getReceipt(latest.receiptIds[0]);
              console.log(`[Seller Agent] Receipt: ${receipt.id}`);
              console.log(`  Hash: ${receipt.receiptHash}`);
              console.log(`  TEE Attestation: ${receipt.t3AttestationRef}`);
              console.log(`  Key Version: ${receipt.keyVersion}`);
            }
          }
        } catch (error) {
          console.error("[Seller Agent] Poll error:", error);
        }
      }, 5000);

      // Run for 60 seconds max
      setTimeout(() => {
        clearInterval(pollInterval);
        console.log("[Seller Agent] Done.");
        process.exit(0);
      }, 60000);
    }
  }
}

main().catch(console.error);
