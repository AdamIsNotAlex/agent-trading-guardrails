import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { ApprovalStore } from "@guardrails/approval";
import { AuditWriter } from "@guardrails/audit";
import {
  ExecutionBroker,
  FileBrokerIdempotencyStore,
  InMemoryKillSwitch,
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
import { createRuntimeConnector, createRuntimeRiskEngine } from "./binance-runtime.js";
import { createBrokerServer } from "./broker-server.js";

export interface Runtime {
  server: Server;
  close(): void;
}

function approvalDatabasePath() {
  const path = process.env.APPROVAL_DB_PATH ?? "./data/approvals.db";
  if (!path.trim()) throw new Error("Approval database path must not be empty.");
  if (path === ":memory:") {
    throw new Error("Runtime approval store requires a durable database path.");
  }
  return path;
}

function closeRuntime(database: Database.Database, approvals?: ApprovalStore) {
  try {
    approvals?.close();
  } finally {
    database.close();
  }
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

function openApprovalStore(writer: AuditWriter, defaultTimeoutSeconds: number) {
  return new ApprovalStore({
    databasePath: approvalDatabasePath(),
    defaultTimeoutSeconds,
    audit: writer,
  });
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
  const risk = createRuntimeRiskEngine(config.environment);
  const { database, writer } = openAudit(config.environment, "guardrail");
  let approvals: ApprovalStore | undefined;
  try {
    approvals = openApprovalStore(writer, config.approvalTimeoutSeconds);
    const service = new GuardrailService(config, reviewer, policy, risk, writer, approvals);
    return {
      server: createGuardrailServer(service),
      close: () => closeRuntime(database, approvals),
    };
  } catch (error) {
    closeRuntime(database, approvals);
    throw error;
  }
}

export function createBrokerRuntime(): Runtime {
  const config = loadDevConfig();
  const { connector, executionMode, canaryLiveEnabled } = createRuntimeConnector(
    config.environment,
  );
  const killSwitch = new InMemoryKillSwitch();
  const killSwitchSetting = process.env.BROKER_KILL_SWITCH ?? "false";
  if (killSwitchSetting !== "true" && killSwitchSetting !== "false") {
    throw new Error("BROKER_KILL_SWITCH must be true or false.");
  }
  if (killSwitchSetting === "true") killSwitch.activate({ type: "global" });
  const idempotencyPath = process.env.BROKER_IDEMPOTENCY_PATH ?? "./data/broker-idempotency.json";
  mkdirSync(dirname(idempotencyPath), { recursive: true, mode: 0o700 });
  const { database, writer } = openAudit(config.environment, "broker");
  let approvals: ApprovalStore | undefined;
  try {
    approvals = openApprovalStore(writer, config.approvalTimeoutSeconds);
    const broker = new ExecutionBroker(
      {
        environment: config.environment,
        canaryLiveEnabled,
        decisionVerificationSecret: config.decisionSigningSecret,
        vaultAddr: config.vaultAddr,
      },
      connector,
      killSwitch,
      writer,
      new FileBrokerIdempotencyStore(idempotencyPath),
      approvals,
    );
    return {
      server: createBrokerServer(broker, executionMode),
      close: () => closeRuntime(database, approvals),
    };
  } catch (error) {
    closeRuntime(database, approvals);
    throw error;
  }
}
