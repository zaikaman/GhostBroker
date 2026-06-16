#!/usr/bin/env node
import { loadAgentEnv } from "./env.js";
import { GroqLlmClient } from "./llm-decision.js";
import { runAgentLoop } from "./run-loop.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();

  if (!env.GHOSTBROKER_URL) {
    console.error("Missing GHOSTBROKER_URL");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_API_KEY) {
    console.error("Missing GHOSTBROKER_API_KEY");
    process.exit(2);
  }
  if (!env.GROQ_API_KEY) {
    console.error("Missing GROQ_API_KEY");
    process.exit(2);
  }

  const llm = new GroqLlmClient({
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
  });

  const result = await runAgentLoop({
    side: env.AGENT_SIDE,
    env,
    llm,
    dryRun: env.DRY_RUN,
    assetCode: env.AGENT_ASSET_CODE,
    quoteAssetCode: env.AGENT_QUOTE_ASSET_CODE,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "aborted" || result.outcome === "admit_failed" ? 2 : 0);
}

main().catch((error: unknown) => {
  console.error("[HOSTED] fatal:", error);
  process.exit(1);
});
