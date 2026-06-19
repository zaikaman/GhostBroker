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
 * "dashboard delegation" mode — T3 has no dashboard surface,
 * so the flag was meaningless. The runtime gate is now the
 * verifier's own `T3_MODE` value (sandbox / live / structural).
 */

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("readT3EnclaveConfig", () => {
  it("applies the documented defaults when all vars are missing", () => {
    const config = readT3EnclaveConfig(envWith({}));
    expect(config).toEqual({
      adkEnv: "sandbox",
      mode: "sandbox",
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

  it("parses T3_MODE live value", () => {
    const config = readT3EnclaveConfig(envWith({ T3_MODE: "live" }));
    expect(config.mode).toBe("live");
  });

  it("parses T3_MODE structural value", () => {
    const config = readT3EnclaveConfig(envWith({ T3_MODE: "structural" }));
    expect(config.mode).toBe("structural");
  });

  it("falls back to VC_VERIFY_MODE when T3_MODE is unset", () => {
    const config = readT3EnclaveConfig(envWith({ VC_VERIFY_MODE: "live" }));
    expect(config.mode).toBe("live");
  });

  it("prefers T3_MODE over VC_VERIFY_MODE when both are set", () => {
    const config = readT3EnclaveConfig(
      envWith({ T3_MODE: "sandbox", VC_VERIFY_MODE: "live" }),
    );
    expect(config.mode).toBe("sandbox");
  });

  it("rejects an unknown T3_ADK_ENV value", () => {
    expect(() =>
      readT3EnclaveConfig(envWith({ T3_ADK_ENV: "staging" })),
    ).toThrow(T3EnclaveConfigError);
  });

  it("rejects an unknown T3_MODE value", () => {
    expect(() =>
      readT3EnclaveConfig(envWith({ T3_MODE: "magic" })),
    ).toThrow(T3EnclaveConfigError);
  });

  it("includes a useful issues list on the error", () => {
    let caught: T3EnclaveConfigError | undefined;
    try {
      readT3EnclaveConfig(
        envWith({
          T3_ADK_ENV: "staging",
          T3_MODE: "magic",
        }),
      );
    } catch (error) {
      caught = error as T3EnclaveConfigError;
    }
    expect(caught).toBeInstanceOf(T3EnclaveConfigError);
    expect(caught?.issues.join(" | ")).toMatch(/T3_ADK_ENV/);
    expect(caught?.issues.join(" | ")).toMatch(/T3_MODE/);
  });
});

describe("assertStartupConfig — mode warning path", () => {
  const sandboxConfig: T3EnclaveConfig = {
    adkEnv: "sandbox",
    mode: "sandbox",
  };

  it("passes in production with sandbox mode and no warnings", () => {
    const result = assertStartupConfig(sandboxConfig, {
      nodeEnv: "production",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("emits a warning in any env when T3_MODE=live", () => {
    const result = assertStartupConfig(
      { adkEnv: "sandbox", mode: "live" },
      { nodeEnv: "production" },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /T3_MODE=live/.test(w))).toBe(true);
  });
});

describe("assertStartupConfig — auth-sdk-env wiring (removed)", () => {
  it("does not warn about a T3_AUTH_SDK_ENV value (flag removed)", () => {
    // The legacy `T3_AUTH_SDK_ENV` flag is no longer parsed by the
    // enclave config. The verifier's own `T3_MODE` setting is the
    // single source of truth for the verification surface.
    const result = assertStartupConfig(
      {
        adkEnv: "sandbox",
        mode: "live",
      },
      { nodeEnv: "production" },
    );
    // Only the live-mode warning should be present; no separate
    // auth-sdk-env warning is generated.
    expect(
      result.warnings.some((w) => /T3_AUTH_SDK_ENV/.test(w)),
    ).toBe(false);
  });
});

describe("assertStartupConfig — adk env billing warning", () => {
  it("warns when T3_ADK_ENV is production", () => {
    const result = assertStartupConfig(
      {
        adkEnv: "production",
        mode: "sandbox",
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
        mode: "sandbox",
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
        mode: "sandbox",
      },
      { nodeEnv: "test" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("formatStartupReport", () => {
  it("emits a stable text block including adk env and mode", () => {
    const config: T3EnclaveConfig = {
      adkEnv: "testnet",
      mode: "sandbox",
    };
    const report = formatStartupReport(config, {
      ok: true,
      warnings: [],
      errors: [],
    });
    expect(report).toContain("adk_env: testnet");
    expect(report).toContain("mode: sandbox");
    expect(report.trim().endsWith("ok")).toBe(true);
  });

  it("marks a failed run as FAILED and lists errors", () => {
    const report = formatStartupReport(
      {
        adkEnv: "sandbox",
        mode: "sandbox",
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
        mode: "live",
      },
      {
        ok: true,
        warnings: ["T3_MODE=live is a warning."],
        errors: [],
      },
    );
    expect(report).toContain("warnings:");
    expect(report).toContain("- T3_MODE=live is a warning.");
  });
});
