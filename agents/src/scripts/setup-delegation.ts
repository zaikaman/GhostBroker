#!/usr/bin/env tsx
/**
 * CLI: mint a delegation credential for the agent.
 *
 * Equivalent to `boundbuyer/src/scripts/setup-delegation.ts`. Resolves
 * the agent DID from the identity file, the user DID from the
 * T3N_API_KEY (or USER_DID env var), and writes a W3C JSON-LD VC to
 * `output/delegations/agent_delegation.json` (or wherever
 * `DELEGATION_CREDENTIAL_PATH` points).
 *
 * Usage:
 *   npm run setup:delegation -- --max-spend 50000
 */
import { runSetupDelegationCli } from "../delegation.js";
import { loadDotEnv } from "../env.js";

try {
  loadDotEnv();
  runSetupDelegationCli();
} catch (err) {
  console.error("[setup-delegation] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
}
