#!/usr/bin/env node
import { loadAgentEnv } from "./env.js";
import { GroqNegotiationClient } from "./negotiation-decision.js";
import { runNegotiationLoop } from "./negotiation-loop.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();

  if (!env.GHOSTBROKER_URL) {
    console.error("Missing GHOSTBROKER_URL");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_SESSION_TOKEN) {
    console.error("Missing GHOSTBROKER_SESSION_TOKEN");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_ID) {
    console.error("Missing GHOSTBROKER_INSTITUTION_ID");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME) {
    console.error("Missing GHOSTBROKER_INSTITUTION_DISPLAY_NAME");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_TENANT_DID) {
    console.error("Missing GHOSTBROKER_INSTITUTION_TENANT_DID");
    process.exit(2);
  }
  if (!env.GROQ_API_KEY) {
    console.error("Missing GROQ_API_KEY");
    process.exit(2);
  }

  const llm = new GroqNegotiationClient({
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
  });

  const result = await runNegotiationLoop({
    side: env.AGENT_SIDE,
    env,
    llm,
    assetCode: env.AGENT_ASSET_CODE,
    quoteAssetCode: env.AGENT_QUOTE_ASSET_CODE,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "admit_failed" ? 2 : 0);
}

main().catch((error: unknown) => {
  console.error("[HOSTED] fatal:", error);
  process.exit(1);
});
