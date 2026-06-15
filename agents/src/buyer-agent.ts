#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent (Ghostbroker delegation flow).
 *
 * Preflight: requires `GHOSTBROKER_URL` + `GHOSTBROKER_API_KEY`.
 * The delegation credential + agent identity are owned by
 * the backend post-Phase 1; the agent process only needs
 * the API key. If `GROQ_API_KEY` is missing, the preflight
 * exits with a clear message.
 *
 * Used by:
 *   - The Phase 2.5 demo orchestrator (spawned as a child
 *     process with the demo API key in env).
 *   - Local development (`npm run buyer`).
 *
 * Usage:
 *   GHOSTBROKER_URL=http://localhost:3001 \
 *   GHOSTBROKER_API_KEY=gbk_... \
 *   GROQ_API_KEY=gsk_... \
 *   npm run buyer
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
    side: "buy",
    env,
    llm,
    dryRun,
    assetCode: "WBTC",
  });

  console.log("\n[BUYER ] run finished:");
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
  console.error("[BUYER ] fatal:", err);
  process.exit(1);
});
