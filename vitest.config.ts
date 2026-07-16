import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 68,
        functions: 85,
        lines: 80
      }
    }
  }
});
