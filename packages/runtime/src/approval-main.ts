import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ApprovalAuditWriter,
  ApprovalCli,
  ApprovalStore,
  JsonFileAllowlistOnboardingStore,
  parseApprovalArgs,
  usage,
} from "@guardrails/approval";
import { AuditWriter } from "@guardrails/audit";
import { Environment } from "@guardrails/schemas";
import { assertNotVaultDevInProduction, redactSecrets } from "@guardrails/secrets";
import Database from "better-sqlite3";

const DEFAULT_APPROVAL_DB_PATH = "./data/approvals.db";
const DEFAULT_APPROVAL_AUDIT_DB_PATH = "./data/approval-audit.db";
const DEFAULT_APPROVAL_AUDIT_ANCHOR_PATH = "./audit-anchor/approval/head.hash";
const SERVICE_BROKER_AUDIT_DEFAULTS = ["./data/guardrail-audit.db", "./data/broker-audit.db"];

export interface ApprovalCliIo {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface RunApprovalCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  io?: ApprovalCliIo;
  watchIntervalMs?: number;
  abortSignal?: AbortSignal;
}

export async function runApprovalCli(options: RunApprovalCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  process.umask(0o077);

  let parsed: ReturnType<typeof parseApprovalArgs>;
  try {
    parsed = parseApprovalArgs(options.argv ?? process.argv.slice(2));
  } catch (error) {
    writeError(io, error);
    return 1;
  }

  if (parsed.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!parsed.command) {
    writeError(io, new Error("Approval command is required."));
    return 1;
  }

  let store: ApprovalStore | undefined;
  try {
    const config = loadApprovalCliConfig(env);
    const databasePath = parsed.dbPath ?? env.APPROVAL_DB_PATH ?? DEFAULT_APPROVAL_DB_PATH;
    assertDurableSqlitePath(databasePath, "Approval database");
    const audit = createApprovalAuditWriter(env, databasePath);
    const allowlistPath = env.APPROVAL_ALLOWLIST_PATH?.trim();
    store = new ApprovalStore({
      defaultTimeoutSeconds: config.approvalTimeoutSeconds,
      databasePath,
      audit,
      allowlistOnboarding: allowlistPath
        ? { store: new JsonFileAllowlistOnboardingStore(allowlistPath), audit }
        : undefined,
    });
    const cli = new ApprovalCli(store);
    if (parsed.command.type === "watch") {
      const watchIntervalMs =
        options.watchIntervalMs ??
        parseOptionalPositiveInteger(env.APPROVAL_WATCH_INTERVAL_MS, "APPROVAL_WATCH_INTERVAL_MS");
      return await watchApprovals(cli, io, watchIntervalMs, options.abortSignal);
    }
    io.stdout.write(`${cli.execute(parsed.command)}\n`);
    return 0;
  } catch (error) {
    writeError(io, error);
    return 1;
  } finally {
    store?.close();
  }
}

function createApprovalAuditWriter(
  env: NodeJS.ProcessEnv,
  approvalDatabasePath: string,
): ApprovalAuditWriter {
  const auditDatabasePath = env.APPROVAL_AUDIT_DB_PATH ?? DEFAULT_APPROVAL_AUDIT_DB_PATH;
  const hashAnchorPath = env.APPROVAL_AUDIT_HASH_ANCHOR_PATH ?? DEFAULT_APPROVAL_AUDIT_ANCHOR_PATH;
  assertDurableSqlitePath(auditDatabasePath, "Approval audit database");
  if (!hashAnchorPath.trim()) {
    throw new Error("Approval audit hash anchor path must not be empty.");
  }
  assertDistinctAuditDatabase(auditDatabasePath, approvalDatabasePath, env);

  return {
    write(event) {
      mkdirSync(dirname(auditDatabasePath), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(hashAnchorPath), { recursive: true, mode: 0o700 });
      const database = new Database(auditDatabasePath, { timeout: 5000 });
      try {
        const writer = new AuditWriter(database, {
          environment: event.environment,
          hashSecret: env.AUDIT_HASH_SECRET ?? "dev-audit-hash-secret",
          hashAnchorPath,
        });
        writer.write(event);
      } finally {
        database.close();
      }
    },
  };
}

function assertDurableSqlitePath(path: string, label: string): void {
  if (!path.trim()) throw new Error(`${label} must not be empty.`);
  if (path.trim().startsWith(":memory:")) {
    throw new Error(`${label} must be a durable file path.`);
  }
}

function assertDistinctAuditDatabase(
  auditDatabasePath: string,
  approvalDatabasePath: string,
  env: NodeJS.ProcessEnv,
): void {
  const collisions = [
    approvalDatabasePath,
    env.GUARDRAIL_AUDIT_DB_PATH,
    env.BROKER_AUDIT_DB_PATH,
    env.AUDIT_DB_PATH,
    ...SERVICE_BROKER_AUDIT_DEFAULTS,
  ].filter((path): path is string => Boolean(path?.trim()));
  if (collisions.some((path) => sameDatabasePath(auditDatabasePath, path))) {
    throw new Error("Approval audit database must not share the approval or service/broker chain.");
  }
}

function sameDatabasePath(left: string, right: string): boolean {
  if (left === ":memory:" || right === ":memory:") return left === right;
  return resolve(left) === resolve(right);
}

function loadApprovalCliConfig(env: NodeJS.ProcessEnv) {
  const environment = Environment.parse(env.GUARDRAIL_ENV?.trim().toLowerCase() ?? "dev");
  if (env.VAULT_ADDR) assertNotVaultDevInProduction(environment, env.VAULT_ADDR);
  return {
    approvalTimeoutSeconds: parsePositiveInteger(
      env.APPROVAL_TIMEOUT_SECONDS,
      "APPROVAL_TIMEOUT_SECONDS",
      300,
    ),
  };
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function watchApprovals(
  cli: ApprovalCli,
  io: ApprovalCliIo,
  watchIntervalMs: number | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<number> {
  let watchError: unknown;
  let stopWatch: (() => void) | undefined;
  let finished = false;

  const stopped = new Promise<void>((resolveStopped) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      stopWatch?.();
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      abortSignal?.removeEventListener("abort", finish);
      resolveStopped();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    if (abortSignal) {
      if (abortSignal.aborted) {
        finish();
        return;
      }
      abortSignal.addEventListener("abort", finish, { once: true });
    }

    try {
      stopWatch = cli.watch(
        (message) => {
          io.stdout.write(`${message}\n`);
        },
        (error) => {
          watchError = error;
          finish();
        },
        watchIntervalMs,
      );
      if (finished) stopWatch();
    } catch (error) {
      watchError = error;
      finish();
    }
  });

  await stopped;
  if (watchError) throw watchError;
  return 0;
}

function writeError(io: ApprovalCliIo, error: unknown): void {
  const message = error instanceof Error ? error.message : "Approval CLI failed.";
  io.stderr.write(`${redactSecrets(message)}\n`);
}

function isCliEntrypoint(
  argv1: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await runApprovalCli();
}
