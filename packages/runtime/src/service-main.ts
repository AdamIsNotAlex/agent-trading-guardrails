import { createGuardrailRuntime } from "./runtime.js";
import { startRuntime } from "./start.js";

await startRuntime("guardrail", createGuardrailRuntime);
