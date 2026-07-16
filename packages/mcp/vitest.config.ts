import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/bin.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
