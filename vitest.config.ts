import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: "frontend",
          root: "./frontend",
          environment: "jsdom",
          globals: true,
          passWithNoTests: true,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "../tests/**",
            "../backend/**",
          ],
        },
      },
      {
        test: {
          name: "backend",
          root: "./backend",
          environment: "node",
          globals: true,
          passWithNoTests: true,
          include: ["src/**/*.{test,spec}.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "../tests/**",
            "../frontend/**",
          ],
        },
      },
    ],
  },
});
