#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent Example
 *
 * This script demonstrates how an institution's autonomous agent
 * connects to GhostBroker, authenticates, submits a buy intent,
 * and monitors for settlement via WebSocket telemetry.
 *
 * Prerequisites:
 *   - npm install ethers  (for EIP-191 signing in the DID challenge flow)
 *   - Or use your own signing method (e.g., MetaMask, hardware wallet)
 *
 * Usage:
 *   export GHOSTBROKER_URL=http://localhost:3001
 *   export ADMIN_PRIVATE_KEY=0x...
 *   export AGENT_PRIVATE_KEY=0x...
 *   npx tsx examples/agent-buyer.ts
 */

import { GhostBrokerClient, DelegationProofBuilder } from "../agent-client/src/index.js";

const GHOSTBROKER_URL = process.env.GHOSTBROKER_URL || "http://localhost:3001";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const CREDENTIAL_JCS = process.env.CREDENTIAL_JCS_BASE64;
const ENCRYPTED_INTENT = process.env.ENCRYPTED_INTENT_ENVELOPE;

async function main(): Promise<void> {
  if (!ADMIN_PRIVATE_KEY || !AGENT_PRIVATE_KEY) {
    console.error("Missing required env vars: ADMIN_PRIVATE_KEY, AGENT_PRIVATE_KEY");
    console.error("Install ethers: npm install ethers");
    process.exit(1);
  }

  const adminKey = new Uint8Array(Buffer.from(ADMIN_PRIVATE_KEY.replace(/^0x/, ""), "hex"));
  const agentKey = new Uint8Array(Buffer.from(AGENT_PRIVATE_KEY.replace(/^0x/, ""), "hex"));

  // Initialize the unified GhostBroker client
  const client = new GhostBrokerClient({ baseUrl: GHOSTBROKER_URL });

  // Step 1: Authenticate using DID challenge flow
  // The signer function signs a server-issued challenge using EIP-191 personal_sign.
  // In production, this would use a hardware wallet or key management service.
  // ethers.js is used here for demonstration — install it with: npm install ethers
  console.log("[Buyer Agent] Authenticating with GhostBroker...");
  const session = await client.authenticate(
    "did:t3n:0xBuyerAgentAddress",
    async (challenge: string) => {
      // Uses ethers.js Wallet for EIP-191 personal_sign
      // Alternative: use @terminal3/t3n-sdk's signing if available
      const { Wallet } = await import("ethers");
      const wallet = new Wallet(ADMIN_PRIVATE_KEY);
      const signature = await wallet.signMessage(challenge);
      return { signature, walletAddress: wallet.address };
    },
  );
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
      // The telemetry client is automatically scoped to your institution after authenticate()
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
