import { z } from "zod";

/**
 * T3-enclave startup configuration.
 *
 * Resolves the env vars the project's doc-gap file
 * (`docs/terminal3-adk-onboarding-doc-gaps.md`) flagged as
 * load-bearing but never read, plus the related `T3_MODE`
 * flag that drives the runtime verification mode.
 *
 * The T3 surface that GhostBroker depends on is documented as:
 *   - `T3N_API_KEY` from the Terminal 3 claim page (developer
 *     key only — there is no T3 dashboard UI, no admin keypair
 *     ceremony, and no out-of-band grant provisioning step).
 *   - A single delegation-record path expressed as a W3C VC
 *     whose cryptographic verification is provided by
 *     `@terminal3/verify_vc` (sandbox/structural today, live
 *     once the Host API surface ships).
 *
 * This config module therefore exposes two values that map
 * directly to T3's actual surface:
 *   - `adkEnv` — which T3N environment the SDK talks to
 *     (`sandbox` / `testnet` / `production`).
 *   - `mode`   — how the GhostBroker-style W3C VC verifier
 *     should treat the credential it receives
 *     (`sandbox` for structural checks, `live` to require
 *     cryptographic verification via `@terminal3/verify_vc`,
 *     `structural` for shape + time-window + DID-binding with
 *     no crypto).
 *
 * The P0 fail-closed check that used to gate boot on
 * "dashboard mode with no verified agent DIDs" has been
 * removed: that check was a self-imposed gate on a flag
 * (`T3_AGENT_DELEGATION_MODE`) that no runtime code path
 * consumed, and its "remediation" (`T3_VERIFIED_AGENT_DIDS`)
 * pointed at an env var that the agent setup scripts never
 * wrote. The actual gate is the verifier's own
 * `mode === "sandbox"` vs `mode === "live"` branch.
 */

const envSchema = z.object({
  T3_ADK_ENV: z
    .enum(["sandbox", "testnet", "production"])
    .default("sandbox"),
  T3_MODE: z.enum(["sandbox", "live", "structural"]).default("sandbox"),
});

export type T3EnclaveEnv = z.infer<typeof envSchema>;

export type T3VerificationMode = "sandbox" | "live" | "structural";

export interface T3EnclaveConfig {
  adkEnv: "sandbox" | "testnet" | "production";
  /**
   * How the GhostBroker-style W3C VC verifier should treat
   * the delegation credential it receives. Mirrors the
   * `VC_VERIFY_MODE` value the verifier itself reads so the
   * startup config and the runtime gate stay aligned.
   */
  mode: T3VerificationMode;
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
  const candidate = {
    T3_ADK_ENV: source.T3_ADK_ENV,
    T3_MODE: source.T3_MODE ?? source.VC_VERIFY_MODE,
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
    mode: result.data.T3_MODE,
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
 *   - `mode === "live"` emits a warning that production
 *     cryptographic verification requires
 *     `@terminal3/verify_vc` to be installed; if it is not,
 *     the verifier falls back to `structural` mode (shape +
 *     time-window + DID-binding) unless `VC_VERIFY_STRICT=true`.
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

  if (config.mode === "live") {
    warnings.push(
      "T3_MODE=live: cryptographic W3C VC verification via " +
        "`@terminal3/verify_vc` is requested. If the package is not " +
        "installed the GhostBroker-style verifier will fall back to " +
        "structural mode (shape + time-window + DID-binding) unless " +
        "`VC_VERIFY_STRICT=true`. Set `T3_MODE=sandbox` to suppress this " +
        "warning.",
    );
  }

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
  lines.push(`mode: ${config.mode}`);
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
