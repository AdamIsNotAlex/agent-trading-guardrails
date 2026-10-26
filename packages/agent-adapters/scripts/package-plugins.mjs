import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pluginConfigSchema, PLUGIN_ID, TOOL_PREFIX } from "../dist/plugin-config.js";
import { getGuardedToolDefinitions } from "../dist/tool-definitions.js";

const root = new URL("../", import.meta.url);
const output = new URL("dist/plugins/", root);
const definitions = getGuardedToolDefinitions();
const toolNames = definitions.map(({ name }) => `${TOOL_PREFIX}${name}`);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

for (const framework of ["openclaw", "hermes"]) {
  await mkdir(new URL(`${framework}/`, output), { recursive: true });
}

await build({
  entryPoints: [fileURLToPath(new URL("src/openclaw-plugin.ts", root))],
  outfile: fileURLToPath(new URL("openclaw/index.mjs", output)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
await build({
  entryPoints: [fileURLToPath(new URL("src/hermes-bridge.ts", root))],
  outfile: fileURLToPath(new URL("hermes/bridge.mjs", output)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});

async function json(relative, value) {
  await writeFile(new URL(relative, output), `${JSON.stringify(value, null, 2)}\n`);
}

await json("openclaw/package.json", {
  name: "@guardrails/openclaw-trading",
  version,
  description: "Guardrail-only trading authorization tools for OpenClaw",
  type: "module",
  main: "./index.mjs",
  files: ["index.mjs", "openclaw.plugin.json"],
  engines: { node: "^22.23.4 || ^24.22.1 || >=26.12.1" },
  openclaw: { extensions: ["./index.mjs"] },
});
await json("openclaw/openclaw.plugin.json", {
  id: PLUGIN_ID,
  name: "Trading Guardrails",
  version,
  description: "Remote authorization only; does not trade, sign, or access credentials.",
  categories: ["other"],
  contracts: { tools: toolNames },
  activation: { onStartup: true },
  toolMetadata: Object.fromEntries(toolNames.map((name) => [name, { optional: true }])),
  configSchema: pluginConfigSchema,
});
await cp(new URL("plugins/hermes/__init__.py", root), new URL("hermes/__init__.py", output));
await json("hermes/tools.json", definitions);
await writeFile(new URL("hermes/plugin.yaml", output), [
  `name: ${PLUGIN_ID}`,
  `version: ${version}`,
  "description: Remote trading authorization through Guardrail; never direct execution",
  "provides_tools:",
  ...toolNames.map((name) => `  - ${name}`),
  "requires_env:",
  "  - GUARDRAIL_URL",
  "  - GUARDRAIL_PRINCIPAL",
  "  - GUARDRAIL_ENV",
  "",
].join("\n"));
console.log(`Standalone OpenClaw and Hermes plugins: ${fileURLToPath(output)}`);
