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
  /**
   * Explicit matching contract version the backend requests from
   * T3N on every `evaluate-match` call. Defaults to `"0.4.0"` —
   * the fractional-decimal wire form (`"0.0001"` for quantities,
   * `"70000"` for prices) that the institutional demo uses end
   * to end; the older `0.3.0` integer-only build returns
   * `no_match` on any sub-unit fill. The T3N adapter reads this
   * off the request body, so changing it here (after a new
   * publish) repoints the backend without a code change.
   */
  T3_MATCHING_CONTRACT_VERSION: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .default("0.4.0"),
  RECEIPT_KEY_VERSION: z.string().min(1).optional(),
  SETTLEMENT_ASSET_CODE: z.string().trim().min(1).max(20).default("USDC"),
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  SEPOLIA_WBTC_CONTRACT_ADDRESS: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  SEPOLIA_USDC_CONTRACT_ADDRESS: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  AUTH_SESSION_SECRET: z.string().min(32).optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  PORTFOLIO_SYNC_TOKEN: z.string().min(32).optional(),
  /**
   * Phase 2.5: Demo Mode.
   *
   * The path to the `agents/` workspace (relative to the
   * backend's CWD). The demo orchestrator spawns
   * `npm run buyer` / `npm run seller` from this
   * directory. Defaults to `../agents` so the standard
   * monorepo layout works without configuration.
   */
  AGENTS_WORKSPACE_DIR: z.string().min(1).optional(),

  /**
   * WS2 — chain rail (Sepolia ERC-20). The rail is opt-in: a
   * missing or empty value means the rail is not registered and
   * every profile `chain:sepolia:erc20` falls through to the
   * noop rail. In production all three are required when the
   * rail is enabled.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL: z.string().url().optional(),
  /**
   * Private key for the relayer that broadcasts the rail's
   * transactions. In production this is held inside a TEE
   * (see `docs/terminal3-adk-onboarding-doc-gaps.md` for the
   * open question on the relayer/signing host interface); for
   * the v1 demo the key is in the backend's env. Always
   * 0x-prefixed 64 hex chars. The dev `0x` test key is allowed
   * because Anvil uses it as a default funded key.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{64}$/iu)
    .optional(),
  /**
   * WS2.5: address of the deployed
   * `GhostBrokerSettlementRelayer` contract. The rail calls
   * `settle(...)` and `reverse(...)` on this contract. The
   * contract source lives at
   * `contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol`
   * and is compiled with `forge build`. The
   * `build:relayer:copy-abi` script copies the artifact into
   * `backend/src/services/settlement-rails/abi/` so viem can
   * type-check the call.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/u)
    .optional(),
  /**
   * WS2.5: a T3 secret-ref (e.g. `t3_secret:abc123`) that
   * the production relayer signer uses to resolve the
   * T3 tenant identity. The relayer's broadcast
   * `from` is the tenant identity's address; in
   * production the tenant key is held inside the T3
   * tenant TEE.
   *
   * When this env var is set, `app.ts` builds a
   * `TeeAttestedRelayerSigner` whose
   * `tenantPrivateKey` is loaded via `t3-enclave`'s
   * `loadOrCreateTenantIdentity(...)`. When unset
   * (the v1 demo), the rail uses the default
   * `ViemWalletRelayerSigner` whose signer key is the
   * `SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`
   * env var. The interface is the same in both cases;
   * the relayer's broadcast tx is identical except
   * for the `from` address.
   *
   * T3-ONB-011: the underlying T3 secret-store +
   * relayer-primitive host interface is still
   * `Coming soon` for external developers. The
   * production migration is a one-line change to
   * `app.ts` once the host interface ships.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_TEE_SIGNER_REF: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional(),
  /**
   * Sepolia chain id. Defaults to 11155111. Override only for
   * forked tests against Anvil (where the id is 31337).
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_CHAIN_ID: z.coerce.number().int().positive().optional(),
  /**
   * Optional: maximum seconds the rail will wait for the chain
   * tx to be confirmed before declaring the dispatch failed.
   * Defaults to 90s in `chain-sepolia-rail.ts`.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_CONFIRM_TIMEOUT_SEC: z.coerce.number().int().positive().optional(),
  /**
   * WS6: master seed used to deterministically derive each
   * institution's server-owned deposit wallet.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_DEPOSIT_WALLET_SEED: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{64}$/iu)
    .optional(),
  /**
   * WS6: canonical Sepolia token addresses used by the chain
   * rail and by the funding / withdrawal flows.
   */
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_WBTC_ADDRESS: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/u)
    .optional(),
  SETTLEMENT_RAIL_CHAIN_SEPOLIA_USDC_ADDRESS: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/u)
    .optional(),
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

