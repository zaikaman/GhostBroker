#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent (boundbuyer flow).
 *
 * Preflight: requires that `npm run setup:identity` and
 * `npm run setup:delegation` have already been run, producing
 *   - output/identities/agent_identity.json
 *   - output/delegations/agent_delegation.json
 *
 * If either file is missing, the agent prints a clear error
 * pointing at the setup commands and exits 2.
 *
 * Usage:
 *   cp .env.example .env       # fill in GHOSTBROKER_API_KEY + T3N_API_KEY
 *   npm run setup:identity
 *   npm run setup:delegation
 *   npm run buyer
 */
import { existsSync } from "node:fs";
import { loadAgentEnv, numberEnv, booleanEnv } from "./env.js";
import { GroqLlmClient } from "./llm-decision.js";
import { runAgentLoop } from "./run-loop.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();
  const dryRun = booleanEnv("DRY_RUN", false) || numberEnv("DRY_RUN", 0) === 1;

  preflightIdentityAndDelegation(env);

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

function preflightIdentityAndDelegation(env: ReturnType<typeof loadAgentEnv>): void {
  if (!existsSync(env.AGENT_IDENTITY_CONFIG_PATH)) {
    console.error(
      `✗ Agent identity not found at ${env.AGENT_IDENTITY_CONFIG_PATH}.`,
    );
    console.error("  Run: npm run setup:identity");
    process.exit(2);
  }
  if (!existsSync(env.DELEGATION_CREDENTIAL_PATH)) {
    console.error(
      `✗ Delegation credential not found at ${env.DELEGATION_CREDENTIAL_PATH}.`,
    );
    console.error("  Run: npm run setup:delegation");
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error("[BUYER ] fatal:", err);
  process.exit(1);
});
