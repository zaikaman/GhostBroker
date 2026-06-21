import { defineConfig } from "vitest/config";

const TEST_ENVELOPE_MASTER_KEY = "a4f1c2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    passWithNoTests: true,
    env: {
      // The deterministic AEAD master key the AEAD envelope
      // cipher loads for tests. The same key is hard-coded in
      // `tests/data/us2-encrypted-intent-builders.ts` so the
      // producer (test fixtures) and consumer (the
      // orchestrator's `decodeSealedEnvelope` fallback) agree
      // on the master key without depending on a real env var.
      ENVELOPE_ENCRYPTION_MASTER_KEY: TEST_ENVELOPE_MASTER_KEY,
    },
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "../coverage/backend"
    }
  }
});