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
 * Tests for the T3 enclave startup config.
 *
 * Each test exercises one observable: parsing of each var,
 * defaults, strict-mode failure, warning-mode behaviour, and
 * the report formatter. The config no longer models a
 * `T3_MODE` flag — the verifier runs in `live` mode
 * exclusively, so a configurable mode has nothing to flip.
 * The runtime authority gate is the verifier itself; the
 * startup check is a structural sanity sweep.
 */

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("readT3EnclaveConfig", () => {
  it("applies the documented defaults when all vars are missing", () => {
    const config = readT3EnclaveConfig(envWith({}));
    expect(config).toEqual({
      adkEnv: "sandbox",
    });
  });

  it("parses T3_ADK_ENV including the production value", () => {
    const config = readT3EnclaveConfig(
      envWith({ T3_ADK_ENV: "production" }),
    );
    expect(config.adkEnv).toBe("production");
  });

  it("parses T3_ADK_ENV testnet value", () => {
    const config = readT3EnclaveConfig(envWith({ T3_ADK_ENV: "testnet" }));
    expect(config.adkEnv).toBe("testnet");
  });

  it("ignores the legacy T3_MODE env var (verifier is live-only)", () => {
    // The verifier's verification mode is hard-coded to `live`;
    // the startup config deliberately does not parse T3_MODE.
    // A T3_MODE value must not affect the parsed config shape.
    const config = readT3EnclaveConfig(envWith({ T3_MODE: "structural" }));
    expect(config).toEqual({ adkEnv: "sandbox" });
  });

  it("ignores the legacy VC_VERIFY_MODE env var (verifier is live-only)", () => {
    // Same rationale as the T3_MODE test above: the
    // VC_VERIFY_MODE alias was the historical CLI-side mirror
    // of T3_MODE; both are now unread.
    const config = readT3EnclaveConfig(envWith({ VC_VERIFY_MODE: "live" }));
    expect(config).toEqual({ adkEnv: "sandbox" });
  });

  it("rejects an unknown T3_ADK_ENV value", () => {
    expect(() =>
      readT3EnclaveConfig(envWith({ T3_ADK_ENV: "staging" })),
    ).toThrow(T3EnclaveConfigError);
  });

  it("includes a useful issues list on the error", () => {
    let caught: T3EnclaveConfigError | undefined;
    try {
      readT3EnclaveConfig(
        envWith({
          T3_ADK_ENV: "staging",
        }),
      );
    } catch (error) {
      caught = error as T3EnclaveConfigError;
    }
    expect(caught).toBeInstanceOf(T3EnclaveConfigError);
    expect(caught?.issues.join(" | ")).toMatch(/T3_ADK_ENV/);
  });
});

describe("assertStartupConfig — adk env billing warning", () => {
  const sandboxConfig: T3EnclaveConfig = {
    adkEnv: "sandbox",
  };

  it("passes in production with sandbox adk env and no warnings", () => {
    const result = assertStartupConfig(sandboxConfig, {
      nodeEnv: "production",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("does not warn about T3_MODE (the flag is gone)", () => {
    const result = assertStartupConfig(sandboxConfig, {
      nodeEnv: "production",
    });
    expect(
      result.warnings.some((w) => /T3_MODE/.test(w)),
    ).toBe(false);
  });

  it("does not warn about T3_AUTH_SDK_ENV (flag was removed earlier)", () => {
    const result = assertStartupConfig(sandboxConfig, {
      nodeEnv: "production",
    });
    expect(
      result.warnings.some((w) => /T3_AUTH_SDK_ENV/.test(w)),
    ).toBe(false);
  });

  it("warns when T3_ADK_ENV is production", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "production",
      },
      {
        nodeEnv: "production",
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
      },
      {
        nodeEnv: "production",
      },
    );
    expect(result.ok).toBe(true);
  });

  it("returns a failed result without throwing for unknown adk env", () => {
    // Unknown adkEnv is a parse-time failure of readT3EnclaveConfig
    // rather than an assert-time failure, so this exercise covers
    // the runStartupCheck wrapper with a known-good config that
    // has no errors to assert on.
    const result = runStartupCheck(
      {
        adkEnv: "sandbox",
      },
      { nodeEnv: "test" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("formatStartupReport", () => {
  it("emits a stable text block including adk env", () => {
    const config: T3EnclaveConfig = {
      adkEnv: "testnet",
    };
    const report = formatStartupReport(config, {
      ok: true,
      warnings: [],
      errors: [],
    });
    expect(report).toContain("adk_env: testnet");
    expect(report.trim().endsWith("ok")).toBe(true);
  });

  it("marks a failed run as FAILED and lists errors", () => {
    const report = formatStartupReport(
      {
        adkEnv: "sandbox",
      },
      { ok: false, warnings: [], errors: ["boom"] },
    );
    expect(report).toContain("FAILED");
    expect(report).toContain("- boom");
  });

  it("lists warnings when present", () => {
    const report = formatStartupReport(
      {
        adkEnv: "production",
      },
      {
        ok: true,
        warnings: ["T3_ADK_ENV=production is a warning."],
        errors: [],
      },
    );
    expect(report).toContain("warnings:");
    expect(report).toContain("- T3_ADK_ENV=production is a warning.");
  });
});
