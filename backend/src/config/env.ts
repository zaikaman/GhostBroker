import { z } from "zod";

function loadProcessEnvFile(source: NodeJS.ProcessEnv): void {
  if (source !== process.env) {
    return;
  }

  // `loadEnvFile` is a Node 20.12+ convenience for local dev. The `?.`
  // guards older Node builds where the function does not exist; the
  // try/catch handles the production case where the platform supplies
  // the env vars and the local `.env` file is absent. A missing file
  // is the expected state on Heroku (env vars come from
  // `heroku config:set`) and must not crash the boot.
  try {
    process.loadEnvFile?.();
  } catch {
    // .env is optional. In production the platform supplies env vars;
    // in dev a missing .env just means the operator is relying on
    // whatever is in their shell environment.
  }
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
  /**
   * Dedicated secp256k1 signing private key the backend uses to
   * sign server-minted delegation VCs. This is a SEPARATE secret
   * from `T3N_API_KEY` (which is the T3N bearer API secret used
   * to authenticate to the T3N network).
   *
   * The two secrets MUST NOT be conflated:
   *
   *   - `T3N_API_KEY` is a bearer secret the T3 SDK uses to
   *     authenticate REST/WS calls. It is intended to be rotated
   *     on a normal schedule (and may be rotated by the T3
   *     claim-page operator without coordinating with the
   *     institution's VC lifecycle).
   *   - `TENANT_SIGNING_PRIVATE_KEY` is the institution's long-
   *     lived signing identity. Rotating it INVALIDATES every
   *     previously-issued delegation VC, so the rotation cadence
   *     is much slower (or zero — production target is to load it
   *     once from a KMS / Vault / HSM and never rotate).
   *
   * If unset, the backend generates a fresh secp256k1 keypair
   * from a CSPRNG on first boot and persists it to the file-
   * backed identity store at
   * `output/identities/tenant_identity.json` so subsequent
   * boots reuse the same identity. In production this env var
   * is the recommended path: load the key from a secret manager
   * (KMS, Vault, HSM) and inject it at boot.
   *
   * Format: `0x`-prefixed 64-hex characters (the standard secp256k1
   * private-key encoding).
   */
  TENANT_SIGNING_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^0x[0-9a-f]{64}$/iu)
    .optional(),
  T3_MATCH_CONTRACT_ID: z.string().min(1).optional(),
  /**
   * Explicit matching contract version the backend requests from
   * T3N on every `evaluate-match`, `seal-ticket`, and
   * `evaluate-pair` call. Defaults to `"0.6.0"` — the version
   * that added the `evaluate-pair` export (the TEE pair
   * authority for negotiation tickets) and corrected the
   * `seal-ticket` hash so the handle is bound to `policy_hash`
   * and `compatibility_token`. The T3N adapter reads this off
   * the request body, so changing it here (after a new publish)
   * repoints the backend without a code change.
   */
  /**
   * The T3 TEE contract version the backend pins on every
   * cross-contract call body. Bumping this (after a new publish)
   * repoints every T3 client (`match`, `negotiation-ticket`,
   * `negotiation-round`) without a code change — the clients
   * forward the value into the request body's `version` field,
   * and the T3N adapter (`readVersionFromBody`) routes execution
   * to the matching published build.
   *
   * Default mirrors `DEFAULT_CONTRACT_VERSION` in
   * `enclave/contract-version.ts` (the single source of truth
   * for the contract version on the backend side). Override
   * here only for staged rollouts where you need to pin a
   * specific tenant build before flipping the constant.
   */
  T3_MATCHING_CONTRACT_VERSION: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .default("0.9.1"),
  RECEIPT_KEY_VERSION: z.string().min(1).optional(),
  SETTLEMENT_ASSET_CODE: z.string().trim().min(1).max(20).default("USDC"),
  /**
   * Master symmetric key the enclave uses to wrap the
   * per-institution AEAD envelope key for the
   * `encryptedIntentEnvelope` field. The wire format is
   * AES-256-GCM (`ghostbroker.envelope.aead/v1`); the master
   * key is the input to HKDF-SHA256 with the institution DID as
   * the salt and the schema version as the info string.
   *
   * Format: 64 hex characters (32 bytes). MUST be set in
   * production. When unset the cipher module falls back to a
   * deterministic dev key derived from a fixed application-
   * domain string -- the dev fallback is for local development
   * and the test suite only, and is exposed via
   * {@link loadEnvelopeMasterKey}'s `fromDevFallback` flag so
   * production boot paths can fail closed.
   */
  ENVELOPE_ENCRYPTION_MASTER_KEY: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/u)
    .optional(),
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  SEPOLIA_WBTC_CONTRACT_ADDRESS: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  SEPOLIA_USDC_CONTRACT_ADDRESS: z.string().trim().regex(/^0x[0-9a-f]{40}$/iu).optional(),
  /**
   * HMAC-SHA256 secret used to sign operator session JWTs. The
   * middleware in `auth/operator-auth.ts` fails closed when this is
   * missing — there is no development fallback. Minimum length is
   * 32 characters so a 256-bit key always fits in the digest.
   */
  AUTH_SESSION_SECRET: z.string().min(32),
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
   * WS4: how often the settlement reconciler sweeps
   * `completed_trades` for unreconciled rows and verifies the
   * chain state via `rail.status(railTradeRef)`. Defaults to
   * 10 minutes (production cadence). Set lower in tests; the
   * web process restarts on every Heroku dyno cycle, so a
   * smaller value reduces drift-window exposure on cold boot.
   */
  SETTLEMENT_RECONCILER_INTERVAL_MS: z.coerce.number().int().min(1000).optional(),
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

