import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    include: ["packages/binance-connector/src/**/*.sandbox.test.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
