#!/usr/bin/env tsx
/**
 * CLI: mint an agent identity by talking to the T3N network.
 *
 * Equivalent to `Ghostbroker delegation/src/scripts/setup-identity.ts`. Hands a
 * fresh secp256k1 keypair to the T3N SDK's `T3nClient.handshake()`
 * + `client.authenticate(...)` flow and persists the resulting
 * `did:t3n:0x...` plus the keypair to `output/identities/agent_identity.json`.
 *
 * Usage:
 *   npm run setup:identity --workspace @ghostbroker/agents
 */
import { setupIdentity } from "../identity.js";
import { loadDotEnv, requireEnv, optionalEnv } from "../env.js";

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = requireEnv("T3N_API_KEY");
  const networkUrl = optionalEnv("T3N_API_URL", "https://cn-api.sg.testnet.t3n.terminal3.io");
  const identityPath = optionalEnv("AGENT_IDENTITY_CONFIG_PATH", "output/identities/agent_identity.json");

  const record = await setupIdentity({ apiKey, networkUrl, identityPath });

  console.log("Agent identity created successfully!");
  console.log(`T3N API URL: ${record.networkUrl}`);
  console.log(`Agent DID: ${record.did}`);
  console.log(`Eth address: ${record.ethAddress}`);
  console.log(`Identity file: ${identityPath}`);
  console.log("");
  console.log("Update your .env:");
  console.log(`AGENT_DID=${record.did}`);
  console.log(`AGENT_IDENTITY_CONFIG_PATH=${identityPath}`);
  console.log("");
  console.log("Next: npm run setup:delegation --workspace @ghostbroker/agents");
}

main().catch((err: unknown) => {
  console.error("[setup-identity] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
