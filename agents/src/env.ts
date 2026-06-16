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
  GHOSTBROKER_API_KEY: z.string().regex(/^gbk_/u, "must start with the gbk_ prefix"),
  T3N_API_KEY: z.string().min(1).optional(),
  T3N_API_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)).optional(),
  AGENT_IDENTITY_CONFIG_PATH: z.string().min(1).optional(),
  AGENT_IDENTITY_DID: z.string().min(1).optional(),
  DELEGATION_CREDENTIAL_PATH: z.string().min(1).optional(),
  VC_VERIFY_MODE: z.enum(["sandbox", "live", "structural"]).default("sandbox").optional(),
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().min(1).default("qwen/qwen3-32b"),
  AGENT_SIDE: z.enum(["buy", "sell"]).default("buy"),
  AGENT_ASSET_CODE: z.string().trim().min(1).max(32).default("WBTC"),
  AGENT_QUOTE_ASSET_CODE: z.string().trim().min(1).max(32).default("USDC"),
  AGENT_OPERATOR_PROMPT: z.string().trim().min(1).max(4_000).optional(),
  REFERENCE_PRICE: z.number().positive(),
  PRICE_BAND_BPS: z.number().positive().default(200),
  QUANTITY_MIN: z.number().positive().default(0.05),
  QUANTITY_MAX: z.number().positive().default(1.0),
  TICK_INTERVAL_MS: z.number().positive().default(15_000),
  MAX_TICKS: z.number().positive().default(40),
  DRY_RUN: z.boolean().default(false),
  AGENT_AVAILABLE_QUOTE_BALANCE: z.coerce.number().nonnegative().optional(),
  AGENT_AVAILABLE_BASE_BALANCE: z.coerce.number().nonnegative().optional(),
  HOSTED_AGENT_ID: z.string().uuid().optional(),
  HOSTED_AGENT_LABEL: z.string().trim().min(1).max(100).optional(),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadAgentEnv(): AgentEnv {
  loadDotEnv();
  const parsed = agentEnvSchema.safeParse({
    GHOSTBROKER_URL: process.env.GHOSTBROKER_URL,
    GHOSTBROKER_API_KEY: process.env.GHOSTBROKER_API_KEY,
    T3N_API_KEY: process.env.T3N_API_KEY === "" ? undefined : process.env.T3N_API_KEY,
    T3N_API_URL: process.env.T3N_API_URL,
    AGENT_IDENTITY_CONFIG_PATH: process.env.AGENT_IDENTITY_CONFIG_PATH,
    AGENT_IDENTITY_DID: process.env.AGENT_IDENTITY_DID,
    DELEGATION_CREDENTIAL_PATH: process.env.DELEGATION_CREDENTIAL_PATH,
    VC_VERIFY_MODE: optionalEnv("VC_VERIFY_MODE", "sandbox"),
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: optionalEnv("GROQ_MODEL", "qwen/qwen3-32b"),
    AGENT_SIDE: optionalEnv("AGENT_SIDE", "buy"),
    AGENT_ASSET_CODE: optionalEnv("AGENT_ASSET_CODE", "WBTC"),
    AGENT_QUOTE_ASSET_CODE: optionalEnv("AGENT_QUOTE_ASSET_CODE", "USDC"),
    AGENT_OPERATOR_PROMPT: optionalEnvMany(["AGENT_OPERATOR_PROMPT"]),
    REFERENCE_PRICE: numberEnvMany(
      ["AGENT_REFERENCE_PRICE", "REFERENCE_PRICE", "REFERENCE_PRICE_USDC_PER_WBTC"],
      70_000,
    ),
    PRICE_BAND_BPS: numberEnv("PRICE_BAND_BPS", 200),
    QUANTITY_MIN: numberEnvMany(
      ["AGENT_QUANTITY_MIN", "QUANTITY_MIN", "QUANTITY_MIN_WBTC"],
      0.05,
    ),
    QUANTITY_MAX: numberEnvMany(
      ["AGENT_QUANTITY_MAX", "QUANTITY_MAX", "QUANTITY_MAX_WBTC"],
      1.0,
    ),
    TICK_INTERVAL_MS: numberEnv("TICK_INTERVAL_MS", 15_000),
    MAX_TICKS: numberEnv("MAX_TICKS", 40),
    DRY_RUN: booleanEnv("DRY_RUN", false),
    AGENT_AVAILABLE_QUOTE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_QUOTE_BALANCE", "AGENT_AVAILABLE_USDC"],
      undefined,
    ),
    AGENT_AVAILABLE_BASE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_BASE_BALANCE", "AGENT_AVAILABLE_WBTC"],
      undefined,
    ),
    HOSTED_AGENT_ID: process.env.HOSTED_AGENT_ID,
    HOSTED_AGENT_LABEL: process.env.HOSTED_AGENT_LABEL,
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
