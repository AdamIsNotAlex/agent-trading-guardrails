import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    env: { APPROVAL_DB_PATH: ":memory:" },
    include: ["packages/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "**/*.sandbox.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
  },
});
