import { z } from "zod";

function loadProcessEnvFile(source: NodeJS.ProcessEnv): void {
  if (source !== process.env) {
    return;
  }

  process.loadEnvFile?.();
}

/** Convert empty-string, whitespace, carriage returns, and placeholder env vars to `undefined` so that `.optional()` fields pass validation. */
function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      result[key] = undefined;
      continue;
    }

    // Clean carriage returns, newlines, and trim whitespace
    let val = value.replace(/[\r\n]+/g, "").trim();

    // Remove surrounding quotes if present
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).trim();
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1).trim();
    }

    // Treat empty, "undefined", "null", or placeholder values as undefined
    if (
      val === "" ||
      val.toLowerCase() === "undefined" ||
      val.toLowerCase() === "null" ||
      (val.includes("<") && val.includes(">")) ||
      val.includes("YOUR_")
    ) {
      result[key] = undefined;
    } else {
      result[key] = val;
    }
  }
  return result;
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  T3N_API_KEY: z.string().min(1),
  T3N_ENV: z.enum(["testnet", "production"]).default("testnet"),
  T3_NETWORK_URL: z.string().url().optional(),
  T3_TENANT_DID: z.string().min(1).optional(),
  T3_MATCH_CONTRACT_ID: z.string().min(1).optional(),
  RECEIPT_KEY_VERSION: z.string().min(1).optional(),
  AUTH_SESSION_SECRET: z.string().min(32).optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export type BackendEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid backend environment: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): BackendEnv {
  loadProcessEnvFile(source);

  const normalized = normalizeEnv(source);
  const result = envSchema.safeParse(normalized);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "environment";
      const invalidValue = normalized[path];
      return `${path}: ${issue.message}${invalidValue !== undefined ? ` (received: ${JSON.stringify(invalidValue)})` : ''}`;
    });

    throw new EnvValidationError(issues);
  }

  return result.data;
}

export function getCorsAllowedOrigins(
  env: Pick<BackendEnv, "CORS_ALLOWED_ORIGINS">,
): readonly string[] {
  if (!env.CORS_ALLOWED_ORIGINS) {
    return [];
  }

  return env.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
