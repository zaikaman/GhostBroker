import { z } from "zod";

/**
 * T3-enclave startup configuration.
 *
 * Resolves the four env vars the project's doc-gap file
 * (`docs/terminal3-adk-onboarding-doc-gaps.md:36-83`, T3-ONB-001)
 * flagged as load-bearing but never read, plus the related
 * `T3_AGENT_GRANT_VERIFICATION_REQUIRED` and
 * `T3_AUTH_SDK_ENV` flags. The P0 finding was: when the
 * delegation mode is `dashboard` and the runtime cannot confirm
 * a verified agent grant, the backend must fail closed instead
 * of starting silently and admitting agents under a missing
 * authority check.
 *
 * The vars themselves are surfaced on the config object so
 * downstream code (runner, sandbox:check, backend) can branch on
 * them as the Terminal 3 surface evolves. The `assertStartupConfig`
 * helper is what actually closes the P0 — it is a single
 * function that any entry point can call before constructing
 * enclave services.
 */

const envSchema = z.object({
  T3_ADK_ENV: z
    .enum(["sandbox", "testnet", "production"])
    .default("sandbox"),
  T3_AUTH_SDK_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  T3_AGENT_DELEGATION_MODE: z
    .enum(["dashboard", "programmatic"])
    .default("dashboard"),
  T3_AGENT_GRANT_VERIFICATION_REQUIRED: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default("true")
    .transform((value) => value === "true" || value === "1"),
});

export type T3EnclaveEnv = z.infer<typeof envSchema>;

export interface T3EnclaveConfig {
  adkEnv: "sandbox" | "testnet" | "production";
  authSdkEnv: "sandbox" | "live";
  agentDelegationMode: "dashboard" | "programmatic";
  agentGrantVerificationRequired: boolean;
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
    T3_AUTH_SDK_ENV: source.T3_AUTH_SDK_ENV,
    T3_AGENT_DELEGATION_MODE: source.T3_AGENT_DELEGATION_MODE,
    T3_AGENT_GRANT_VERIFICATION_REQUIRED:
      source.T3_AGENT_GRANT_VERIFICATION_REQUIRED,
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
    authSdkEnv: result.data.T3_AUTH_SDK_ENV,
    agentDelegationMode: result.data.T3_AGENT_DELEGATION_MODE,
    agentGrantVerificationRequired:
      result.data.T3_AGENT_GRANT_VERIFICATION_REQUIRED,
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
  /**
   * Set of agent DIDs the runtime has successfully verified a
   * grant for in this process lifetime. The P0 remediation
   * requires that, when `agentDelegationMode === "dashboard"`
   * and `agentGrantVerificationRequired === true`, at least one
   * agent has a verified grant before the backend starts
   * accepting admits.
   */
  verifiedAgentDids: ReadonlySet<string>;
  /**
   * When true, the check is allowed to pass even if no agent
   * grant has been verified yet. Used by the sandbox:check
   * script (which is invoked before any agent runs) and by
   * integration tests that intentionally boot a fresh
   * environment.
   */
  skipAgentGrantCheck?: boolean;
}

export interface StartupCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Fail-closed startup check. Closes T3-ONB-001:
 * "Add a build-time or startup check that fails if required
 * programmatic delegation methods are unavailable or if
 * dashboard-only setup is required."
 *
 * Strict behavior in `production`:
 *   - `agentDelegationMode === "dashboard"` +
 *     `agentGrantVerificationRequired === true` +
 *     `verifiedAgentDids` empty ⇒ fails.
 *   - Unknown `adkEnv` (i.e. a typo like `prod`) ⇒ fails.
 *   - `authSdkEnv === "live"` is currently a warning because
 *     the Terminal 3 `agent-auth` Host API is still coming
 *     soon per the public docs; this becomes an error when
 *     the surface ships.
 *
 * Best-effort behavior in `development` / `test`:
 *   - Same checks, but emit `warnings` instead of `errors`
 *     and return `ok: true` so the local-dev loop doesn't
 *     need to mint a verified agent grant before it can boot.
 */
export function assertStartupConfig(
  config: T3EnclaveConfig,
  options: AssertStartupOptions,
): StartupCheckResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (
    config.agentDelegationMode === "dashboard" &&
    config.agentGrantVerificationRequired &&
    !options.skipAgentGrantCheck
  ) {
    if (options.verifiedAgentDids.size === 0) {
      const message =
        "Dashboard delegation mode is selected with grant verification required, " +
        "but no agent grant has been verified in this process lifetime. " +
        "Run setup:identity + setup:delegation (or the boundbuyer flow), or set " +
        "T3_AGENT_GRANT_VERIFICATION_REQUIRED=false to opt out of the P0 check.";
      if (options.nodeEnv === "production") {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  if (config.authSdkEnv === "live") {
    warnings.push(
      "T3_AUTH_SDK_ENV=live. The Terminal 3 agent-auth Host API is " +
        "marked coming soon in the reviewed public docs; the boundbuyer " +
        "verifier will still run in sandbox/structural mode until a live " +
        "agent-auth surface ships. See docs/terminal3-adk-onboarding-doc-gaps.md.",
    );
  }

  if (config.adkEnv === "production") {
    warnings.push(
      "T3_ADK_ENV=production. Production T3N calls are billable; confirm " +
        "the tenant has sufficient token balance before booting.",
    );
  }

  if (
    config.agentDelegationMode === "programmatic" &&
    config.authSdkEnv !== "live"
  ) {
    warnings.push(
      `T3_AGENT_DELEGATION_MODE=programmatic but T3_AUTH_SDK_ENV=${config.authSdkEnv}. ` +
        "The programmatic Host API is not yet available, so the boundbuyer verifier " +
        "will be the active path. Switch T3_AGENT_DELEGATION_MODE=dashboard until " +
        "the live surface ships.",
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
  lines.push(`auth_sdk_env: ${config.authSdkEnv}`);
  lines.push(`agent_delegation_mode: ${config.agentDelegationMode}`);
  lines.push(
    `agent_grant_verification_required: ${config.agentGrantVerificationRequired}`,
  );
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
