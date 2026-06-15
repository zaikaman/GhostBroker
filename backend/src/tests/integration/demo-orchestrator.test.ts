import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcessDemoAgentOrchestrator } from "../../services/demo-orchestrator.js";
import type { ApiKeyManagementService } from "../../services/api-key.service.js";
import type { ApiKey, ApiKeyCreatedResponse } from "../../models/api-key.js";

/**
 * Integration test for the demo orchestrator.
 *
 * Exercises the start/stop/status state machine by
 * spawning a tiny `node -e "process.exit(0)"` script as
 * the "agent" — fast, deterministic, and no real
 * orchestrator-host LLM key required.
 *
 * The orchestrator's mints-an-API-key path is also
 * covered: the test's stub `apiKeyService` records the
 * call so we can assert the orchestrator mints one and
 * revokes it on stop.
 */

interface MintedKey {
  id: string;
  institutionId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  key: string;
}

class StubApiKeyService implements Pick<ApiKeyManagementService, "createKey" | "revokeKey"> {
  public minted: MintedKey[] = [];
  public revoked: { id: string; institutionId: string }[] = [];
  private next = 1;

  public async createKey(
    institutionId: string,
    label: string,
    scopes: string[],
  ): Promise<ApiKeyCreatedResponse> {
    const id = `stub-key-${this.next++}`;
    const key: MintedKey = {
      id,
      institutionId,
      label,
      scopes,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      key: `gbk_stub_${id}`,
    };
    this.minted.push(key);
    return key as unknown as ApiKeyCreatedResponse;
  }

  public async revokeKey(id: string, institutionId: string): Promise<void> {
    const m = this.minted.find((k) => k.id === id);
    if (m) {
      m.revokedAt = new Date().toISOString();
    }
    this.revoked.push({ id, institutionId });
  }
}

describe("DemoAgentOrchestrator (state machine)", () => {
  let tmp: string;
  let fakeScriptsDir: string;
  let apiKeyService: StubApiKeyService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ghostbroker-demo-orch-"));
    fakeScriptsDir = join(tmp, "agents");
    mkdirSync(fakeScriptsDir, { recursive: true });
    // Build a tiny npm-runner-shaped dir. We don't use
    // real `npm run` (it would invoke the user's env,
    // require Node on PATH, and race the test runner);
    // instead we point the orchestrator at a `node` script
    // by writing a `package.json` whose `scripts.buyer`
    // is a literal node command, then calling `npm run
    // buyer` from a `cwd` that has that package.json.
    // The orchestrator's `spawn("npm", ...)` will run
    // npm, which resolves the script. We make the script
    // sleep briefly so `stopDemo()` has something to
    // SIGTERM, then exit.
    const fakePkg = {
      name: "fake-agents",
      version: "0.0.0",
      private: true,
      scripts: {
        buyer: "node ./buyer.js",
        seller: "node ./seller.js",
      },
    };
    writeFileSync(
      join(fakeScriptsDir, "package.json"),
      JSON.stringify(fakePkg),
      "utf8",
    );
    // buyer.js / seller.js: sleep 30s then exit 0.
    // Using `node:child_process` setTimeout keeps the
    // process alive long enough for stopDemo() to kill.
    const longRunner = "setTimeout(() => process.exit(0), 30000);\n";
    writeFileSync(join(fakeScriptsDir, "buyer.js"), longRunner, "utf8");
    writeFileSync(join(fakeScriptsDir, "seller.js"), longRunner, "utf8");

    apiKeyService = new StubApiKeyService();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("startDemo spawns buyer + seller, status reports running, stopDemo revokes the API key", async () => {
    const orchestrator = new ChildProcessDemoAgentOrchestrator({
      agentsDir: fakeScriptsDir,
      backendUrl: "http://localhost:3001",
      apiKeyService: apiKeyService as unknown as ApiKeyManagementService,
      // Use `node` directly with explicit script paths
      // so the test doesn't depend on `npm` being on
      // PATH (Windows + the vitest runner's spawned env
      // can disagree on `npm.cmd` resolution).
      runner: ["node"],
      buyerScript: join(fakeScriptsDir, "buyer.js"),
      sellerScript: join(fakeScriptsDir, "seller.js"),
    });

    const initial = orchestrator.getStatus();
    expect(initial.running).toBe(false);

    const apiKeyId = "route-handler-minted-key-uuid";
    const started = await orchestrator.startDemo({
      institutionId: "00000000-0000-4000-8000-000000000101",
      demoApiKey: "gbk_test_demo_key",
      apiKeyId,
    });
    expect(started.running).toBe(true);
    expect(started.buyerPid).toBeGreaterThan(0);
    expect(started.sellerPid).toBeGreaterThan(0);
    expect(started.institutionId).toBe(
      "00000000-0000-4000-8000-000000000101",
    );
    // The orchestrator no longer mints its own key —
    // the route handler owns the lifecycle. No stub
    // calls should have been made.
    expect(apiKeyService.minted).toHaveLength(0);

    // Second startDemo while running is refused.
    await expect(
      orchestrator.startDemo({
        institutionId: "00000000-0000-4000-8000-000000000101",
        demoApiKey: "gbk_test_demo_key",
        apiKeyId: "another-key-uuid",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const mid = orchestrator.getStatus();
    expect(mid.running).toBe(true);

    await orchestrator.stopDemo();
    // stopDemo revokes the apiKeyId that was passed to startDemo.
    expect(apiKeyService.revoked).toEqual([
      { id: apiKeyId, institutionId: "00000000-0000-4000-8000-000000000101" },
    ]);

    const after = orchestrator.getStatus();
    expect(after.running).toBe(false);

    // stopDemo is idempotent.
    const stop2 = await orchestrator.stopDemo();
    expect(stop2.running).toBe(false);
  });

  it("startDemo rejects a malformed demo API key", async () => {
    const orchestrator = new ChildProcessDemoAgentOrchestrator({
      agentsDir: fakeScriptsDir,
      backendUrl: "http://localhost:3001",
      apiKeyService: apiKeyService as unknown as ApiKeyManagementService,
      runner: ["node"],
      buyerScript: join(fakeScriptsDir, "buyer.js"),
      sellerScript: join(fakeScriptsDir, "seller.js"),
    });
    await expect(
      orchestrator.startDemo({
        institutionId: "00000000-0000-4000-8000-000000000101",
        demoApiKey: "not-a-valid-prefix",
        apiKeyId: "irrelevant-key-uuid",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// Helper so tsc doesn't trip on the unused `ApiKey`
// import in this test file. (The cast in the integration
// test path uses the structural shape.)
const _typeProbe: ApiKey | undefined = undefined;
void _typeProbe;
