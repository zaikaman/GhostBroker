import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  T3_NETWORK_URL: z.string().url(),
  T3_TENANT_DID: z.string().min(1),
  T3_WALLET_PRIVATE_KEY_REF: z.string().min(1),
  T3_MATCH_CONTRACT_ID: z.string().min(1),
  RECEIPT_KEY_VERSION: z.string().min(1),
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
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "environment";
      return `${path}: ${issue.message}`;
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
