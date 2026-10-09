import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { AuditWriter } from "@guardrails/audit";
import {
  ExecutionBroker,
  FileBrokerIdempotencyStore,
  InMemoryKillSwitch,
  PaperExecutionConnector,
} from "@guardrails/broker";
import { OpenAiLlmProvider, ReviewerAdapter } from "@guardrails/reviewer";
import type { Environment } from "@guardrails/schemas";
import {
  createGuardrailServer,
  GuardrailService,
  loadDevConfig,
  OpaHttpPolicyEvaluator,
} from "@guardrails/service";
import Database from "better-sqlite3";
import { createBrokerServer } from "./broker-server.js";
import { createFileRiskEngine } from "./risk-snapshot.js";

export interface Runtime {
  server: Server;
  close(): void;
}

function openAudit(environment: Environment, role: "guardrail" | "broker") {
  const prefix = role.toUpperCase();
  const path =
    process.env[`${prefix}_AUDIT_DB_PATH`] ??
    process.env.AUDIT_DB_PATH ??
    `./data/${role}-audit.db`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const anchorPath =
    process.env[`${prefix}_AUDIT_HASH_ANCHOR_PATH`] ?? process.env.AUDIT_HASH_ANCHOR_PATH;
  if (anchorPath) mkdirSync(dirname(anchorPath), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  try {
    const writer = new AuditWriter(database, { environment, hashAnchorPath: anchorPath });
    return { database, writer };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createGuardrailRuntime(): Runtime {
  const config = loadDevConfig();
  const provider = process.env.REVIEWER_PROVIDER ?? "openai";
  if (provider !== "openai") throw new Error("REVIEWER_PROVIDER must be openai.");
  const model = process.env.REVIEWER_MODEL ?? "gpt-5.5";
  const reviewer = new ReviewerAdapter(
    { provider, model },
    new OpenAiLlmProvider({ apiKey: process.env.OPENAI_API_KEY ?? "", model }),
  );
  const policy = new OpaHttpPolicyEvaluator({ opaUrl: config.opaUrl });
  const risk = createFileRiskEngine(process.env.RISK_DATA_PATH ?? "./data/risk/risk-snapshot.json");
  const { database, writer } = openAudit(config.environment, "guardrail");
  try {
    const service = new GuardrailService(config, reviewer, policy, risk, writer);
    return { server: createGuardrailServer(service), close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createBrokerRuntime(): Runtime {
  const config = loadDevConfig();
  // Never silently route a live/testnet intent into simulated execution.
  if (config.environment !== "dev" && config.environment !== "paper") {
    throw new Error("The standalone paper broker requires GUARDRAIL_ENV=dev or paper.");
  }
  const killSwitch = new InMemoryKillSwitch();
  const killSwitchSetting = process.env.BROKER_KILL_SWITCH ?? "false";
  if (killSwitchSetting !== "true" && killSwitchSetting !== "false") {
    throw new Error("BROKER_KILL_SWITCH must be true or false.");
  }
  if (killSwitchSetting === "true") killSwitch.activate({ type: "global" });
  const idempotencyPath = process.env.BROKER_IDEMPOTENCY_PATH ?? "./data/broker-idempotency.json";
  mkdirSync(dirname(idempotencyPath), { recursive: true, mode: 0o700 });
  const { database, writer } = openAudit(config.environment, "broker");
  try {
    const broker = new ExecutionBroker(
      {
        environment: config.environment,
        canaryLiveEnabled: false,
        decisionVerificationSecret: config.decisionSigningSecret,
        vaultAddr: config.vaultAddr,
      },
      new PaperExecutionConnector(),
      killSwitch,
      writer,
      new FileBrokerIdempotencyStore(idempotencyPath),
    );
    return { server: createBrokerServer(broker), close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
