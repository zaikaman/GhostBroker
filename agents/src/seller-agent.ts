#!/usr/bin/env node
/**
 * GhostBroker Seller Agent (Ghostbroker delegation flow).
 *
 * Mirror of `buyer-agent.ts` with `side="sell"`. Post-Phase
 * 1, the preflight only requires `GHOSTBROKER_URL`,
 * `GHOSTBROKER_API_KEY`, and `GROQ_API_KEY`. The
 * delegation credential + agent identity are owned by
 * the backend.
 */
import { loadAgentEnv, numberEnv, booleanEnv } from "./env.js";
import { GroqLlmClient } from "./llm-decision.js";
import { runAgentLoop } from "./run-loop.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();
  const dryRun = booleanEnv("DRY_RUN", false) || numberEnv("DRY_RUN", 0) === 1;

  preflightCredentials(env);

  const llm = new GroqLlmClient({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL });

  const result = await runAgentLoop({
    side: "sell",
    env,
    llm,
    dryRun,
    assetCode: "WBTC",
  });

  console.log("\n[SELLER] run finished:");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "aborted" || result.outcome === "admit_failed" ? 2 : 0);
}

function preflightCredentials(env: ReturnType<typeof loadAgentEnv>): void {
  if (!env.GHOSTBROKER_URL) {
    console.error("✗ Missing GHOSTBROKER_URL");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_API_KEY) {
    console.error("✗ Missing GHOSTBROKER_API_KEY");
    process.exit(2);
  }
  if (!env.GROQ_API_KEY) {
    console.error(
      "✗ Missing GROQ_API_KEY — set it in your shell or pass it through the spawn env",
    );
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error("[SELLER] fatal:", err);
  process.exit(1);
});
