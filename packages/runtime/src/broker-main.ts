import { createBrokerRuntime } from "./runtime.js";
import { startRuntime } from "./start.js";

await startRuntime("broker", createBrokerRuntime);
