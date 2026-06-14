import {
  createAuthenticatedT3NetworkClient,
  type AuthenticatedT3NetworkClientOptions,
} from "./t3n-client.js";
import {
  InsufficientT3TokenBalanceError,
  SandboxTokenBalanceClient,
} from "./token-balance.js";
import {
  readT3EnclaveConfig,
  runStartupCheck,
  T3EnclaveConfigError,
} from "./config.js";
import type { Environment } from "@terminal3/t3n-sdk";

interface SandboxCheckEnv {
  T3N_API_KEY: string;
  T3N_ENV: Environment;
  T3_NETWORK_URL?: string;
  T3_TENANT_DID?: string;
  T3_SANDBOX_TOKEN_ACCOUNT: string;
  T3_MINIMUM_TOKEN_BALANCE: string;
  T3_ADK_ENV: string;
  T3_PRIVATE_MAP_PREFIX: string;
}

const requiredKeys = [
  "T3N_API_KEY",
  "T3N_ENV",
  "T3_SANDBOX_TOKEN_ACCOUNT",
  "T3_ADK_ENV",
  "T3_PRIVATE_MAP_PREFIX",
] as const;

function loadLocalEnv(): void {
  process.loadEnvFile?.();
}

function readT3Environment(value: string | undefined): Environment {
  if (value === "testnet" || value === "production") {
    return value;
  }

  throw new Error("T3N_ENV must be either testnet or production.");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function readEnv(): SandboxCheckEnv {
  loadLocalEnv();

  const missing = requiredKeys.filter((key) => {
    const value = process.env[key];
    return !value || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Missing T3 sandbox environment variables: ${missing.join(", ")}`);
  }

  const env: SandboxCheckEnv = {
    T3N_API_KEY: requireEnv("T3N_API_KEY"),
    T3N_ENV: readT3Environment(process.env.T3N_ENV),
    T3_SANDBOX_TOKEN_ACCOUNT: requireEnv("T3_SANDBOX_TOKEN_ACCOUNT"),
    T3_MINIMUM_TOKEN_BALANCE: process.env.T3_MINIMUM_TOKEN_BALANCE ?? "1",
    T3_ADK_ENV: requireEnv("T3_ADK_ENV"),
    T3_PRIVATE_MAP_PREFIX: requireEnv("T3_PRIVATE_MAP_PREFIX"),
  };

  if (process.env.T3_NETWORK_URL) {
    env.T3_NETWORK_URL = process.env.T3_NETWORK_URL;
  }

  if (process.env.T3_TENANT_DID) {
    env.T3_TENANT_DID = process.env.T3_TENANT_DID;
  }

  return env;
}

function parseMinimumTokenBalance(value: string): bigint {
  try {
    const minimum = BigInt(value);

    if (minimum < 0n) {
      throw new Error("Token balance minimum cannot be negative.");
    }

    return minimum;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `T3_MINIMUM_TOKEN_BALANCE must be a non-negative integer: ${detail}`,
      { cause: error },
    );
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const options: AuthenticatedT3NetworkClientOptions = {
    apiKey: env.T3N_API_KEY,
    environment: env.T3N_ENV,
  };

  if (env.T3_NETWORK_URL) {
    options.networkUrl = env.T3_NETWORK_URL;
  }

  if (env.T3_TENANT_DID) {
    options.expectedTenantDid = env.T3_TENANT_DID;
  }

  const networkClient = await createAuthenticatedT3NetworkClient(options);
  const tokenBalanceClient = new SandboxTokenBalanceClient(networkClient);
  const minimumTokenBalance = parseMinimumTokenBalance(
    env.T3_MINIMUM_TOKEN_BALANCE,
  );

  const balance = await tokenBalanceClient.assertMinimumBalance(
    env.T3_SANDBOX_TOKEN_ACCOUNT,
    minimumTokenBalance,
  );

  // Run the new fail-closed P0 startup check (T3-ONB-001). The
  // CLI surfaces the result instead of throwing so operators can
  // see the warnings; the backend wrapper uses the same function
  // and does throw.
  const startupConfig = readT3EnclaveConfig();
  const startupResult = runStartupCheck(startupConfig, {
    nodeEnv: (process.env.NODE_ENV as
      | "development"
      | "test"
      | "production"
      | undefined) ?? "development",
    verifiedAgentDids: new Set<string>(),
    skipAgentGrantCheck: true,
  });

  console.log(
    JSON.stringify(
      {
        status: "ok",
        apiKeyConfigured: env.T3N_API_KEY.length > 0,
        t3nEnv: env.T3N_ENV,
        adkEnv: env.T3_ADK_ENV,
        tenantDid: env.T3_TENANT_DID ?? "authenticated-session",
        privateMapPrefix: env.T3_PRIVATE_MAP_PREFIX,
        tokenAccount: balance.account,
        tokenBalanceAvailable: balance.available.toString(),
        tokenBalanceMinimum: balance.minimumRequired.toString(),
        startupCheck: {
          authSdkEnv: startupConfig.authSdkEnv,
          agentDelegationMode: startupConfig.agentDelegationMode,
          agentGrantVerificationRequired:
            startupConfig.agentGrantVerificationRequired,
          ok: startupResult.ok,
          warnings: startupResult.warnings,
          errors: startupResult.errors,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof InsufficientT3TokenBalanceError
      ? "T3 sandbox token balance is below the configured minimum."
      : error instanceof T3EnclaveConfigError
        ? `T3 enclave config invalid: ${error.issues.join("; ")}`
        : error instanceof Error
          ? error.message
          : "T3 sandbox check failed.";

  console.error(message);
  process.exitCode = 1;
});
