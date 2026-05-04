import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/audit/src/schema.ts",
  out: "./packages/audit/drizzle",
});
