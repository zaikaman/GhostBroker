import { describe, expect, it } from "vitest";
import { isDelegationActive, loadDelegationCredential, mintDelegationCredential } from "./delegation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("delegation credential minting/loading", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-delegation-test-"));

  it("mints a structurally-valid VC", () => {
    const { path, credential } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "mint.json"),
    });
    expect(path).toBe(join(tmp, "mint.json"));
    expect(credential.id).toMatch(/^urn:uuid:ghostbroker-delegation-/);
    expect(credential.credentialSubject.agentDid).toBe("did:t3n:0xagent");
    expect(credential.credentialSubject.maxSpendUsd).toBe(1_000);
  });

  it("loads back the minted VC through the zod schema", () => {
    const { path } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "roundtrip.json"),
    });
    const loaded = loadDelegationCredential(path);
    expect(loaded.credentialSubject.agentDid).toBe("did:t3n:0xagent");
  });

  it("rejects an unknown purchase category", () => {
    const badPath = join(tmp, "bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        id: "urn:uuid:bad",
        type: ["VerifiableCredential", "GhostBrokerDelegation"],
        issuer: "did:t3n:0x0000000000000000000000000000000000000001",
        issuanceDate: "2026-01-01T00:00:00Z",
        expirationDate: "2027-01-01T00:00:00Z",
        credentialSubject: {
          id: "did:t3n:0x0000000000000000000000000000000000000001",
          agentDid: "did:t3n:0xagent",
          maxSpendUsd: 1_000,
          allowedCategories: ["weapons"], // not in the enum
          purpose: "test",
        },
      }),
      "utf8",
    );
    expect(() => loadDelegationCredential(badPath)).toThrow();
  });

  it("isDelegationActive is true within the window and false outside", () => {
    const { path } = mintDelegationCredential({
      apiKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
      userDid: undefined,
      agentDid: "did:t3n:0xagent",
      maxSpendUsd: 1_000,
      outputPath: join(tmp, "active.json"),
    });
    const loaded = loadDelegationCredential(path);
    expect(isDelegationActive(loaded, new Date("2026-06-15T00:00:00Z"))).toBe(true);
    expect(isDelegationActive(loaded, new Date("2020-01-01T00:00:00Z"))).toBe(false);
  });

  // Cleanup
  it("cleanup tmp dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
