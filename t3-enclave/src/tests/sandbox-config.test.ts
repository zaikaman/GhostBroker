import { describe, expect, it } from "vitest";
import {
  T3EnclaveConfigError,
  assertStartupConfig,
  formatStartupReport,
  readT3EnclaveConfig,
  runStartupCheck,
  type T3EnclaveConfig,
} from "../sandbox/config.js";

/**
 * Tests for the T3 enclave startup config — the closure of
 * T3-ONB-001 from `docs/terminal3-adk-onboarding-doc-gaps.md`.
 *
 * Each test exercises one observable: parsing of each var,
 * defaults, strict-mode failure, warning-mode, and the
 * fail-closed production path.
 */

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("readT3EnclaveConfig", () => {
  it("applies the documented defaults when all vars are missing", () => {
    const config = readT3EnclaveConfig(envWith({}));
    expect(config).toEqual({
      adkEnv: "sandbox",
      authSdkEnv: "sandbox",
      agentDelegationMode: "dashboard",
      agentGrantVerificationRequired: true,
    });
  });

  it("parses T3_ADK_ENV including the production value", () => {
    const config = readT3EnclaveConfig(
      envWith({ T3_ADK_ENV: "production" }),
    );
    expect(config.adkEnv).toBe("production");
  });

  it("parses T3_AUTH_SDK_ENV live value", () => {
    const config = readT3EnclaveConfig(envWith({ T3_AUTH_SDK_ENV: "live" }));
    expect(config.authSdkEnv).toBe("live");
  });

  it("parses T3_AGENT_DELEGATION_MODE programmatic value", () => {
    const config = readT3EnclaveConfig(
      envWith({ T3_AGENT_DELEGATION_MODE: "programmatic" }),
    );
    expect(config.agentDelegationMode).toBe("programmatic");
  });

  it("parses T3_AGENT_GRANT_VERIFICATION_REQUIRED truthy forms", () => {
    expect(
      readT3EnclaveConfig(
        envWith({ T3_AGENT_GRANT_VERIFICATION_REQUIRED: "true" }),
      ).agentGrantVerificationRequired,
    ).toBe(true);
    expect(
      readT3EnclaveConfig(
        envWith({ T3_AGENT_GRANT_VERIFICATION_REQUIRED: "1" }),
      ).agentGrantVerificationRequired,
    ).toBe(true);
  });

  it("parses T3_AGENT_GRANT_VERIFICATION_REQUIRED falsy forms", () => {
    expect(
      readT3EnclaveConfig(
        envWith({ T3_AGENT_GRANT_VERIFICATION_REQUIRED: "false" }),
      ).agentGrantVerificationRequired,
    ).toBe(false);
    expect(
      readT3EnclaveConfig(
        envWith({ T3_AGENT_GRANT_VERIFICATION_REQUIRED: "0" }),
      ).agentGrantVerificationRequired,
    ).toBe(false);
  });

  it("rejects an unknown T3_ADK_ENV value", () => {
    expect(() =>
      readT3EnclaveConfig(envWith({ T3_ADK_ENV: "staging" })),
    ).toThrow(T3EnclaveConfigError);
  });

  it("rejects an unknown T3_AGENT_DELEGATION_MODE value", () => {
    expect(() =>
      readT3EnclaveConfig(
        envWith({ T3_AGENT_DELEGATION_MODE: "magic" }),
      ),
    ).toThrow(T3EnclaveConfigError);
  });

  it("rejects an unknown T3_AGENT_GRANT_VERIFICATION_REQUIRED value", () => {
    expect(() =>
      readT3EnclaveConfig(
        envWith({ T3_AGENT_GRANT_VERIFICATION_REQUIRED: "yes" }),
      ),
    ).toThrow(T3EnclaveConfigError);
  });

  it("includes a useful issues list on the error", () => {
    let caught: T3EnclaveConfigError | undefined;
    try {
      readT3EnclaveConfig(
        envWith({
          T3_ADK_ENV: "staging",
          T3_AUTH_SDK_ENV: "maybe",
          T3_AGENT_DELEGATION_MODE: "magic",
          T3_AGENT_GRANT_VERIFICATION_REQUIRED: "yes",
        }),
      );
    } catch (error) {
      caught = error as T3EnclaveConfigError;
    }
    expect(caught).toBeInstanceOf(T3EnclaveConfigError);
    expect(caught?.issues.join(" | ")).toMatch(/T3_ADK_ENV/);
    expect(caught?.issues.join(" | ")).toMatch(/T3_AUTH_SDK_ENV/);
    expect(caught?.issues.join(" | ")).toMatch(/T3_AGENT_DELEGATION_MODE/);
    expect(caught?.issues.join(" | ")).toMatch(
      /T3_AGENT_GRANT_VERIFICATION_REQUIRED/,
    );
  });
});

describe("assertStartupConfig — P0 fail-closed path", () => {
  const dashboardConfig: T3EnclaveConfig = {
    adkEnv: "sandbox",
    authSdkEnv: "sandbox",
    agentDelegationMode: "dashboard",
    agentGrantVerificationRequired: true,
  };

  it("fails in production with no verified DIDs and dashboard mode", () => {
    const result = assertStartupConfig(dashboardConfig, {
      nodeEnv: "production",
      verifiedAgentDids: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Dashboard delegation/);
  });

  it("passes in production with at least one verified DID", () => {
    const result = assertStartupConfig(dashboardConfig, {
      nodeEnv: "production",
      verifiedAgentDids: new Set(["did:t3n:0xagent"]),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("emits warnings (not errors) in development with no verified DIDs", () => {
    const result = assertStartupConfig(dashboardConfig, {
      nodeEnv: "development",
      verifiedAgentDids: new Set(),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  it("skips the dashboard check when skipAgentGrantCheck is true", () => {
    const result = assertStartupConfig(dashboardConfig, {
      nodeEnv: "production",
      verifiedAgentDids: new Set(),
      skipAgentGrantCheck: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("skips the dashboard check when grant verification is disabled", () => {
    const result = assertStartupConfig(
      { ...dashboardConfig, agentGrantVerificationRequired: false },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("assertStartupConfig — auth-sdk-env wiring", () => {
  it("warns when T3_AUTH_SDK_ENV=live because the host API is still coming soon", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "sandbox",
        authSdkEnv: "live",
        agentDelegationMode: "dashboard",
        agentGrantVerificationRequired: true,
      },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(["did:t3n:0xagent"]),
      },
    );
    expect(result.warnings.some((w) => /T3_AUTH_SDK_ENV=live/.test(w))).toBe(
      true,
    );
  });

  it("warns when programmatic mode is selected without the live auth surface", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "sandbox",
        authSdkEnv: "sandbox",
        agentDelegationMode: "programmatic",
        agentGrantVerificationRequired: true,
      },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(["did:t3n:0xagent"]),
      },
    );
    expect(
      result.warnings.some((w) =>
        /T3_AGENT_DELEGATION_MODE=programmatic/.test(w),
      ),
    ).toBe(true);
  });

  it("does not warn about the live + programmatic mismatch when both are set", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "sandbox",
        authSdkEnv: "live",
        agentDelegationMode: "programmatic",
        agentGrantVerificationRequired: true,
      },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(["did:t3n:0xagent"]),
      },
    );
    expect(
      result.warnings.some((w) =>
        /T3_AGENT_DELEGATION_MODE=programmatic/.test(w),
      ),
    ).toBe(false);
  });
});

describe("assertStartupConfig — adk env billing warning", () => {
  it("warns when T3_ADK_ENV is production", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "production",
        authSdkEnv: "sandbox",
        agentDelegationMode: "dashboard",
        agentGrantVerificationRequired: true,
      },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(["did:t3n:0xagent"]),
      },
    );
    expect(result.warnings.some((w) => /T3_ADK_ENV=production/.test(w))).toBe(
      true,
    );
  });
});

describe("runStartupCheck", () => {
  it("returns the result on success", () => {
    const result = runStartupCheck(
      {
        adkEnv: "sandbox",
        authSdkEnv: "sandbox",
        agentDelegationMode: "dashboard",
        agentGrantVerificationRequired: true,
      },
      {
        nodeEnv: "production",
        verifiedAgentDids: new Set(["did:t3n:0xagent"]),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("throws T3EnclaveConfigError on a failed check", () => {
    let caught: T3EnclaveConfigError | undefined;
    try {
      runStartupCheck(
        {
          adkEnv: "sandbox",
          authSdkEnv: "sandbox",
          agentDelegationMode: "dashboard",
          agentGrantVerificationRequired: true,
        },
        {
          nodeEnv: "production",
          verifiedAgentDids: new Set(),
        },
      );
    } catch (error) {
      caught = error as T3EnclaveConfigError;
    }
    expect(caught).toBeInstanceOf(T3EnclaveConfigError);
    expect(caught?.issues.length).toBeGreaterThan(0);
  });
});

describe("formatStartupReport", () => {
  it("emits a stable text block including all four env values", () => {
    const config: T3EnclaveConfig = {
      adkEnv: "testnet",
      authSdkEnv: "sandbox",
      agentDelegationMode: "dashboard",
      agentGrantVerificationRequired: true,
    };
    const report = formatStartupReport(config, {
      ok: true,
      warnings: [],
      errors: [],
    });
    expect(report).toContain("adk_env: testnet");
    expect(report).toContain("auth_sdk_env: sandbox");
    expect(report).toContain("agent_delegation_mode: dashboard");
    expect(report).toContain("agent_grant_verification_required: true");
    expect(report.trim().endsWith("ok")).toBe(true);
  });

  it("marks a failed run as FAILED and lists errors", () => {
    const report = formatStartupReport(
      {
        adkEnv: "sandbox",
        authSdkEnv: "sandbox",
        agentDelegationMode: "dashboard",
        agentGrantVerificationRequired: true,
      },
      { ok: false, warnings: [], errors: ["boom"] },
    );
    expect(report).toContain("FAILED");
    expect(report).toContain("- boom");
  });

  it("lists warnings when present", () => {
    const report = formatStartupReport(
      {
        adkEnv: "sandbox",
        authSdkEnv: "live",
        agentDelegationMode: "dashboard",
        agentGrantVerificationRequired: true,
      },
      {
        ok: true,
        warnings: ["T3_AUTH_SDK_ENV=live is a warning."],
        errors: [],
      },
    );
    expect(report).toContain("warnings:");
    expect(report).toContain("- T3_AUTH_SDK_ENV=live is a warning.");
  });
});
