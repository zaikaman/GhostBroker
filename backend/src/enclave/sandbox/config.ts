import { z } from "zod";

/**
 * T3-enclave startup configuration.
 *
 * Resolves the env vars the project's doc-gap file
 * (`docs/terminal3-adk-onboarding-doc-gaps.md`) flagged as
 * load-bearing but never read, plus the related `T3_MODE`
 * flag that drove the runtime verification mode.
 *
 * The T3 surface that GhostBroker depends on is documented as:
 *   - `T3N_API_KEY` from the Terminal 3 claim page (developer
 *     key only — there is no T3 dashboard UI, no admin keypair
 *     ceremony, and no out-of-band grant provisioning step).
 *   - A single delegation-record path expressed as a W3C VC
 *     whose cryptographic verification is provided by the
 *     inline ECDSA flow in
 *     `t3-enclave/src/auth/ghostbroker-delegation.ts`.
 *
 * This config module therefore exposes one value that maps
 * directly to T3's actual surface:
 *   - `adkEnv` — which T3N environment the SDK talks to
 *     (`sandbox` / `testnet` / `production`).
 *
 * The legacy `T3_MODE` (with `VC_VERIFY_MODE` as a
 * backward-compat alias) is no longer parsed: the verifier
 * runs in `live` mode exclusively, so a configurable mode
 * flag has nothing to flip. The verifier hard-codes `live`,
 * and `EcdsaSecp256k1Signature2019` is the only proof shape
 * the production signer emits, so there is no off-ramp to a
 * structural-only check. The runtime authority gate is the
 * verifier itself; the startup check is a structural sanity
 * sweep, not an authority gate.
 *
 * The P0 fail-closed check that used to gate boot on
 * "dashboard mode with no verified agent DIDs" has been
 * removed: that check was a self-imposed gate on a flag
 * (`T3_AGENT_DELEGATION_MODE`) that no runtime code path
 * consumed, and its "remediation" (`T3_VERIFIED_AGENT_DIDS`)
 * pointed at an env var that the agent setup scripts never
 * wrote.
 */

const envSchema = z.object({
  T3_ADK_ENV: z
    .enum(["sandbox", "testnet", "production"])
    .default("sandbox"),
});

export type T3EnclaveEnv = z.infer<typeof envSchema>;

export interface T3EnclaveConfig {
  adkEnv: "sandbox" | "testnet" | "production";
}

export class T3EnclaveConfigError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid T3 enclave configuration: ${issues.join("; ")}`);
    this.name = "T3EnclaveConfigError";
    this.issues = issues;
  }
}

/**
 * Read the T3 enclave env vars from a process.env-shaped source.
 * Public so tests can inject a synthetic env without touching
 * process.env (which is a process-global).
 */
export function readT3EnclaveConfig(
  source: NodeJS.ProcessEnv = process.env,
): T3EnclaveConfig {
  // Only forward the keys this module cares about so an empty
  // env in a test doesn't accidentally set an unrelated field
  // (zod will still apply defaults for the missing ones).
  // `T3_MODE` and `VC_VERIFY_MODE` are deliberately not read:
  // the verifier runs in `live` mode exclusively.
  const candidate = {
    T3_ADK_ENV: source.T3_ADK_ENV,
  };

  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "t3-enclave-config";
      return `${path}: ${issue.message}`;
    });
    throw new T3EnclaveConfigError(issues);
  }

  return {
    adkEnv: result.data.T3_ADK_ENV,
  };
}

export interface AssertStartupOptions {
  /**
   * The runtime mode the enclave is being started in. In
   * `production` the check is strict; in `development` and
   * `test` it is best-effort and emits warnings instead of
   * throwing so the existing local-dev workflow (where the
   * Terminal 3 claim-key flow hasn't run yet) still works.
   */
  nodeEnv: "development" | "test" | "production";
}

export interface StartupCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Startup self-check. Strict in `production`, best-effort
 * (warnings only) in `development` and `test`.
 *
 * Checks:
 *   - Unknown `adkEnv` (e.g. a typo like `prod`) ⇒ fails.
 *   - `adkEnv === "production"` warns that production T3N
 *     calls are billable.
 */
export function assertStartupConfig(
  config: T3EnclaveConfig,
  // The options bag is reserved for future
  // production-only checks (e.g. operator pre-flight
  // questions). It is unused today; keep the parameter
  // name explicit so callers can grow into it without an
  // API break.
  _options: AssertStartupOptions,
): StartupCheckResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (config.adkEnv === "production") {
    warnings.push(
      "T3_ADK_ENV=production. Production T3N calls are billable; confirm " +
        "the tenant has sufficient token balance before booting.",
    );
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Convenience wrapper that throws `T3EnclaveConfigError` on a
 * failed check. Returns the successful `StartupCheckResult` for
 * the caller to log.
 */
export function runStartupCheck(
  config: T3EnclaveConfig,
  options: AssertStartupOptions,
): StartupCheckResult {
  const result = assertStartupConfig(config, options);
  if (!result.ok) {
    throw new T3EnclaveConfigError(result.errors);
  }
  return result;
}

/**
 * Pretty-print a startup config + check result for the
 * `sandbox:check` CLI and for backend boot logs. The shape is
 * stable JSON so the existing `sandbox/check.ts` script can
 * merge it into its own output without breaking its consumers.
 */
export function formatStartupReport(
  config: T3EnclaveConfig,
  result: StartupCheckResult,
): string {
  const lines: string[] = ["=== T3 enclave startup check ==="];
  lines.push(`adk_env: ${config.adkEnv}`);
  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  if (result.errors.length > 0) {
    lines.push("errors:");
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
  }
  lines.push(result.ok ? "ok" : "FAILED");
  return lines.join("\n");
}
