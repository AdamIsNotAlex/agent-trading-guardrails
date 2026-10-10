import { createSignerRuntime } from "./signer-runtime.js";
import { startRuntime } from "./start.js";

await startRuntime("signer", createSignerRuntime);
