import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    passWithNoTests: true,
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