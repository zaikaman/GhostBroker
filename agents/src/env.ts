import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Minimal `.env` loader — no dotenv dependency. Mirrors the pattern
 * used by `agent-client/examples/buyer-agent.ts` and the boundbuyer
 * BUIDL. Looks for `.env` in the CWD first, then in the `agents/`
 * package folder. Env vars already set in `process.env` are never
 * overridden.
 */
export function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(import.meta.dirname, "..", ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

/** Read a required env var and exit with a clear message if missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`✗ Missing required env var: ${name}`);
    console.error("  Copy agents/.env.example to agents/.env and fill it in,");
    console.error("  or export the vars inline before invoking the agent.");
    process.exit(1);
  }
  return value;
}

/** Read an optional env var with a default. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  return value;
}

/** Parse a positive number from an env var, with a default. */
export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`✗ Env var ${name} must be a finite number, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

/** Parse a boolean from an env var (true/false/1/0/yes/no, case-insensitive). */
export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  console.error(`✗ Env var ${name} must be a boolean, got: ${raw}`);
  process.exit(1);
  return fallback;
}

/**
 * The full set of env vars a boundbuyer-style GhostBroker agent needs.
 * Validated at startup so a missing credential is a clear error and
 * not a stack trace buried inside the SDK.
 */
export const agentEnvSchema = z.object({
  GHOSTBROKER_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)),
  GHOSTBROKER_API_KEY: z.string().regex(/^gbk_/u, "must start with the gbk_ prefix"),

  /**
   * T3N claim-page key. This is the **only** T3 secret the agent
   * needs. It is used to derive both the user DID (via
   * `eth_get_address(apiKey)`) and the agent DID (via
   * `T3nClient.handshake()` + `client.authenticate(...)`).
   */
  T3N_API_KEY: z.string().min(1),
  T3N_API_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)),
  AGENT_IDENTITY_CONFIG_PATH: z.string().min(1).default("output/identities/agent_identity.json"),
  DELEGATION_CREDENTIAL_PATH: z.string().min(1).default("output/delegations/agent_delegation.json"),
  /** Verifier mode on the server: sandbox | live | structural. */
  VC_VERIFY_MODE: z.enum(["sandbox", "live", "structural"]).default("sandbox"),

  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().min(1).default("qwen/qwen3-32b"),

  REFERENCE_PRICE_USDC_PER_WBTC: z.number().positive(),
  PRICE_BAND_BPS: z.number().positive().default(200),
  QUANTITY_MIN_WBTC: z.number().positive().default(0.05),
  QUANTITY_MAX_WBTC: z.number().positive().default(1.0),

  TICK_INTERVAL_MS: z.number().positive().default(15_000),
  MAX_TICKS: z.number().positive().default(40),
  DRY_RUN: z.boolean().default(false),

  /**
   * Optional fallback balances for the LLM prompt. The agent's
   * primary balance source is `client.getAgentPortfolio(...)`,
   * which returns the live `portfolios.balance - locked` for each
   * holding. The LLM is fed the live numbers on every tick.
   *
   * These env vars are used **only** when the SDK call fails (e.g.
   * transient 503 from the backend) so the loop can keep running
   * with a stale-but-finite balance instead of forcing a hard
   * "0 available" through to the LLM. Leaving them unset means a
   * 503 results in 0-available context — the LLM is told it can't
   * trade until the SDK recovers, which is the safe default.
   *
   * The orchestrator's balance-lock check is the real authority
   * on whether a submit will succeed; the LLM is just a sizing
   * hint.
   */
  AGENT_AVAILABLE_USDC: z.coerce.number().nonnegative().optional(),
  AGENT_AVAILABLE_WBTC: z.coerce.number().nonnegative().optional(),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadAgentEnv(): AgentEnv {
  loadDotEnv();
  const parsed = agentEnvSchema.safeParse({
    GHOSTBROKER_URL: process.env.GHOSTBROKER_URL,
    GHOSTBROKER_API_KEY: process.env.GHOSTBROKER_API_KEY,
    T3N_API_KEY: process.env.T3N_API_KEY,
    T3N_API_URL: optionalEnv("T3N_API_URL", "https://cn-api.sg.testnet.t3n.terminal3.io"),
    AGENT_IDENTITY_CONFIG_PATH: process.env.AGENT_IDENTITY_CONFIG_PATH,
    DELEGATION_CREDENTIAL_PATH: process.env.DELEGATION_CREDENTIAL_PATH,
    VC_VERIFY_MODE: optionalEnv("VC_VERIFY_MODE", "sandbox"),
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: optionalEnv("GROQ_MODEL", "qwen/qwen3-32b"),
    REFERENCE_PRICE_USDC_PER_WBTC: numberEnv("REFERENCE_PRICE_USDC_PER_WBTC", 70_000),
    PRICE_BAND_BPS: numberEnv("PRICE_BAND_BPS", 200),
    QUANTITY_MIN_WBTC: numberEnv("QUANTITY_MIN_WBTC", 0.05),
    QUANTITY_MAX_WBTC: numberEnv("QUANTITY_MAX_WBTC", 1.0),
    TICK_INTERVAL_MS: numberEnv("TICK_INTERVAL_MS", 15_000),
    MAX_TICKS: numberEnv("MAX_TICKS", 40),
    DRY_RUN: booleanEnv("DRY_RUN", false),
    AGENT_AVAILABLE_USDC: process.env.AGENT_AVAILABLE_USDC === undefined || process.env.AGENT_AVAILABLE_USDC === ""
      ? undefined
      : Number(process.env.AGENT_AVAILABLE_USDC),
    AGENT_AVAILABLE_WBTC: process.env.AGENT_AVAILABLE_WBTC === undefined || process.env.AGENT_AVAILABLE_WBTC === ""
      ? undefined
      : Number(process.env.AGENT_AVAILABLE_WBTC),
  });
  if (!parsed.success) {
    console.error("✗ Invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
