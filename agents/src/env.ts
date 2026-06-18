import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

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

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  return value;
}

export function optionalEnvMany(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`Missing or invalid numeric env var: ${name}=${raw}`);
    process.exit(1);
  }
  return parsed;
}

export function numberEnvMany(
  names: readonly string[],
  fallback?: number,
): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim().length === 0) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      console.error(`Missing or invalid numeric env var: ${name}=${raw}`);
      process.exit(1);
    }
    return parsed;
  }
  return fallback;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  console.error(`Missing or invalid boolean env var: ${name}=${raw}`);
  process.exit(1);
  return fallback;
}

export const agentEnvSchema = z.object({
  GHOSTBROKER_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)),
  GHOSTBROKER_API_KEY: z.string().regex(/^gbk_/u, "must start with the gbk_ prefix").optional(),
  GHOSTBROKER_SESSION_TOKEN: z.string().trim().min(1).optional(),
  GHOSTBROKER_SESSION_EXPIRES_AT: z.string().trim().min(1).optional(),
  GHOSTBROKER_INSTITUTION_ID: z.string().uuid().optional(),
  GHOSTBROKER_INSTITUTION_DISPLAY_NAME: z.string().trim().min(1).optional(),
  GHOSTBROKER_INSTITUTION_TENANT_DID: z.string().trim().min(1).optional(),
  T3N_API_KEY: z.string().min(1).optional(),
  T3N_API_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)).optional(),
  AGENT_IDENTITY_CONFIG_PATH: z.string().min(1).optional(),
  AGENT_IDENTITY_DID: z.string().min(1).optional(),
  DELEGATION_CREDENTIAL_PATH: z.string().min(1).optional(),
  VC_VERIFY_MODE: z.enum(["sandbox", "live", "structural"]).default("sandbox").optional(),

  // ── LLM provider chain (Gemini primary, OpenAI fallback, Groq last) ──
  /**
   * Comma-separated provider order. The agent tries each in turn and
   * falls back on transient failures (5xx, 429, network, empty /
   * malformed responses). Auth / 400 errors are fatal — a different
   * provider won't accept a prompt that one rejected. Default:
   * `gemini,openai,groq`.
   */
  LLM_PROVIDER_CHAIN: z.string().trim().min(1).optional(),
  /** Primary provider — Gemini (v98store proxy). */
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.1-flash-lite"),
  GEMINI_BASE_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)).optional(),
  /** Fallback #1 — OpenAI-compatible (Azure OpenAI in this workspace). */
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5-nano"),
  OPENAI_BASE_URL: z
    .string()
    .url()
    .or(z.string().regex(/^https?:\/\//u))
    .optional(),
  /** Fallback #2 — Groq (existing). */
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().trim().min(1).default("qwen/qwen3-32b"),
  GROQ_BASE_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)).optional(),

  POLL_INTERVAL_MS: z.number().positive().default(1_000),
  AGENT_QUOTE_ASSET_CODE: z.string().trim().min(1).max(32).default("USDC"),
  MAX_TICKS: z.number().positive().default(40),
  DRY_RUN: z.boolean().default(false),
  /**
   * Protocol choreography mode for the hosted negotiator.
   *
   *   - `"guarded_fast"` (default for hosted demo): the LLM still
   *      proposes price / rationale, but the agent loop's
   *      `selectGuardedNegotiationMove` helper owns the action
   *      choreography (open with `propose`, request and reveal
   *      `accredited_institution` once, never ask for
   *      `settlement_capacity`, accept when the cross is feasible).
   *
   *   - `"llm_freeform"`: the LLM owns every action and the loop
   *      forwards its decision verbatim (kept for non-demo
   *      experimentation).
   */
  PROTOCOL_MODE: z
    .enum(["guarded_fast", "llm_freeform"])
    .default("guarded_fast"),
  AGENT_AVAILABLE_QUOTE_BALANCE: z.coerce.number().nonnegative().optional(),
  AGENT_AVAILABLE_BASE_BALANCE: z.coerce.number().nonnegative().optional(),
  HOSTED_AGENT_ID: z.string().uuid().optional(),
  HOSTED_MANDATE_ID: z.string().uuid().optional(),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadAgentEnv(): AgentEnv {
  loadDotEnv();
  const parsed = agentEnvSchema.safeParse({
    GHOSTBROKER_URL: process.env.GHOSTBROKER_URL,
    GHOSTBROKER_API_KEY: process.env.GHOSTBROKER_API_KEY,
    GHOSTBROKER_SESSION_TOKEN: process.env.GHOSTBROKER_SESSION_TOKEN,
    GHOSTBROKER_SESSION_EXPIRES_AT: process.env.GHOSTBROKER_SESSION_EXPIRES_AT,
    GHOSTBROKER_INSTITUTION_ID: process.env.GHOSTBROKER_INSTITUTION_ID,
    GHOSTBROKER_INSTITUTION_DISPLAY_NAME: process.env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME,
    GHOSTBROKER_INSTITUTION_TENANT_DID: process.env.GHOSTBROKER_INSTITUTION_TENANT_DID,
    T3N_API_KEY: process.env.T3N_API_KEY === "" ? undefined : process.env.T3N_API_KEY,
    T3N_API_URL: process.env.T3N_API_URL,
    AGENT_IDENTITY_CONFIG_PATH: process.env.AGENT_IDENTITY_CONFIG_PATH,
    AGENT_IDENTITY_DID: process.env.AGENT_IDENTITY_DID,
    DELEGATION_CREDENTIAL_PATH: process.env.DELEGATION_CREDENTIAL_PATH,
    VC_VERIFY_MODE: optionalEnv("VC_VERIFY_MODE", "sandbox"),
    LLM_PROVIDER_CHAIN: process.env.LLM_PROVIDER_CHAIN,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY === "" ? undefined : process.env.GEMINI_API_KEY,
    GEMINI_MODEL: optionalEnv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY === "" ? undefined : process.env.OPENAI_API_KEY,
    OPENAI_MODEL: optionalEnv("OPENAI_MODEL", "gpt-5-nano"),
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GROQ_API_KEY: process.env.GROQ_API_KEY === "" ? undefined : process.env.GROQ_API_KEY,
    GROQ_MODEL: optionalEnv("GROQ_MODEL", "qwen/qwen3-32b"),
    GROQ_BASE_URL: process.env.GROQ_BASE_URL,
    POLL_INTERVAL_MS: numberEnv("POLL_INTERVAL_MS", 1_000),
    AGENT_QUOTE_ASSET_CODE: optionalEnv("AGENT_QUOTE_ASSET_CODE", "USDC"),
    MAX_TICKS: numberEnv("MAX_TICKS", 40),
    DRY_RUN: booleanEnv("DRY_RUN", false),
    PROTOCOL_MODE: optionalEnv("PROTOCOL_MODE", "guarded_fast"),
    AGENT_AVAILABLE_QUOTE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_QUOTE_BALANCE", "AGENT_AVAILABLE_USDC"],
      undefined,
    ),
    AGENT_AVAILABLE_BASE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_BASE_BALANCE", "AGENT_AVAILABLE_WBTC"],
      undefined,
    ),
    HOSTED_AGENT_ID: process.env.HOSTED_AGENT_ID,
    HOSTED_MANDATE_ID: process.env.HOSTED_MANDATE_ID,
  });
  if (!parsed.success) {
    console.error("Invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
