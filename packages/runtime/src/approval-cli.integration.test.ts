import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ApprovalStore } from "@guardrails/approval";
import { AuditWriter } from "@guardrails/audit";
import type { Environment } from "@guardrails/schemas";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApprovalCli } from "./approval-main.js";

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../dist/approval-main.js", import.meta.url));
const GENESIS_HASH = "0".repeat(64);

const baseParams = {
  intentId: "intent-001",
  correlationId: "corr-001",
  principal: "agent.openclaw.alpha",
  action: "cex.place_order",
  resource: "cex:binance:sub:ETH-USDC",
  environment: "dev" as const,
  escalationReason: "Notional above auto threshold.",
  approvalType: "one_time" as const,
  intentData: { symbol: "ETH-USDC", maxNotionalUsd: 20 },
};

let directory: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "approval-cli-"));
  vi.stubEnv("GUARDRAIL_ENV", "dev");
  vi.stubEnv("AUDIT_HASH_SECRET", "dev-audit-hash-secret");
  vi.stubEnv("APPROVAL_DB_PATH", join(directory, "approvals.db"));
  vi.stubEnv("APPROVAL_AUDIT_DB_PATH", join(directory, "approval-audit.db"));
  vi.stubEnv("APPROVAL_AUDIT_HASH_ANCHOR_PATH", join(directory, "approval.hash"));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("standalone approval CLI", () => {
  it("lists full ids and shows a shared pending request", async () => {
    const request = createPending();
    const listed = await runCli(["--", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(request.approvalId);
    expect(listed.stdout).not.toContain(`[${request.approvalId.slice(0, 8)}]`);

    const shown = await runCli(["show", request.approvalId]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      approvalId: request.approvalId,
      state: "pending",
    });
  });

  it("approves and denies with durable audit and refuses overwrite", async () => {
    const approved = createPending();
    const denied = createPending();

    const approve = await runCli(["approve", approved.approvalId, "--by", "operator-1"]);
    expect(approve.code).toBe(0);
    expect(readState(approved.approvalId)).toBe("approved");

    const deny = await runCli(["deny", denied.approvalId, "--by", "operator-2"]);
    expect(deny.code).toBe(0);
    expect(readState(denied.approvalId)).toBe("denied");

    const overwrite = await runCli(["approve", denied.approvalId, "--by", "operator-1"]);
    expect(overwrite.code).toBe(1);
    expect(readState(denied.approvalId)).toBe("denied");
    expect(inspectAudit().count).toBe(2);
  });

  it("fails closed for missing ids, invalid args, and expired requests", async () => {
    const missing = await runCli(["show", "missing-id"]);
    expect(missing.code).toBe(1);

    const invalid = await runCli(["approve", "id-only"]);
    expect(invalid.code).toBe(1);

    const expired = createPending({ defaultTimeoutSeconds: -1 });
    const timedOut = await runCli(["approve", expired.approvalId, "--by", "operator"]);
    expect(timedOut.code).toBe(1);
    expect(readState(expired.approvalId)).toBe("timeout");
  });

  it("rejects unsafe audit paths, blank anchors, and production events", async () => {
    const memoryDb = await runCli(["list", "--db", ":memory:"]);
    expect(memoryDb.code).toBe(1);

    const memoryAudit = await runCli(["list"], { APPROVAL_AUDIT_DB_PATH: ":memory:" });
    expect(memoryAudit.code).toBe(1);

    const blankAnchor = await runCli(["list"], { APPROVAL_AUDIT_HASH_ANCHOR_PATH: "" });
    expect(blankAnchor.code).toBe(1);

    const shared = await runCli(["list", "--db", join(directory, "approval-audit.db")], {
      APPROVAL_AUDIT_DB_PATH: join(directory, "approval-audit.db"),
    });
    expect(shared.code).toBe(1);

    const serviceDefault = await runCli(["list"], {
      APPROVAL_AUDIT_DB_PATH: "./data/guardrail-audit.db",
    });
    expect(serviceDefault.code).toBe(1);

    const production = createPending({ environment: "production" });
    const blocked = await runCli(["approve", production.approvalId, "--by", "operator"]);
    expect(blocked.code).toBe(1);
    expect(readState(production.approvalId)).toBe("pending");
  });

  it("watch sees cross-process inserts and shuts down cleanly", async () => {
    const child = spawnCli(["watch"], { APPROVAL_WATCH_INTERVAL_MS: "50" });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    const request = createPending();
    await expect.poll(() => stdout).toContain(request.approvalId);

    child.kill("SIGINT");
    const [code, signal] = await once(child, "exit");
    expect(signal ?? null).toBeNull();
    expect(code).toBe(0);
  });

  it("cleans up watch signals when the first tick fails", async () => {
    createPending({ defaultTimeoutSeconds: -1 });
    const auditDirectory = join(directory, "audit-dir");
    mkdirSync(auditDirectory);
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const result = await runCli(["watch"], { APPROVAL_AUDIT_DB_PATH: auditDirectory });
    expect(result.code).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  });

  it("serializes concurrent CLI audit writers on a shared approval database", async () => {
    const first = createPending();
    const second = createPending();
    const [left, right] = await Promise.all([
      execCli(["approve", first.approvalId, "--by", "operator-a"]),
      execCli(["approve", second.approvalId, "--by", "operator-b"]),
    ]);
    expect(left.code).toBe(0);
    expect(right.code).toBe(0);
    expect(readState(first.approvalId)).toBe("approved");
    expect(readState(second.approvalId)).toBe("approved");
    const audit = inspectAudit();
    expect(audit.count).toBe(2);
    expect(audit.lastHash).not.toBe(GENESIS_HASH);
    expect(audit.hashes).toHaveLength(2);
    expect(audit.hashes[0]?.previousHash).toBe(GENESIS_HASH);
    expect(audit.hashes[1]?.previousHash).toBe(audit.hashes[0]?.eventHash);
    expect(audit.lastHash).toBe(audit.hashes[1]?.eventHash);
  });
});

function createPending(
  overrides: { environment?: Environment; defaultTimeoutSeconds?: number } = {},
) {
  return withStore(
    (store) =>
      store.create({
        ...baseParams,
        environment: overrides.environment ?? baseParams.environment,
      }),
    overrides.defaultTimeoutSeconds,
  );
}

function withStore<T>(fn: (store: ApprovalStore) => T, defaultTimeoutSeconds = 300): T {
  const store = new ApprovalStore({
    defaultTimeoutSeconds,
    databasePath: process.env.APPROVAL_DB_PATH,
  });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function readState(approvalId: string) {
  return withStore((store) => store.get(approvalId)?.state);
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const pending = collect();
  const code = await runApprovalCli({
    argv,
    env: { ...process.env, ...env },
    io: pending.io,
  });
  return { code, stdout: pending.stdout(), stderr: pending.stderr() };
}

async function execCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function spawnCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return child;
}

function collect() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function inspectAudit() {
  const path = process.env.APPROVAL_AUDIT_DB_PATH;
  const hashAnchorPath = process.env.APPROVAL_AUDIT_HASH_ANCHOR_PATH;
  if (!path || !hashAnchorPath) throw new Error("missing approval audit path");
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const writer = new AuditWriter(database, {
      environment: "dev",
      hashSecret: process.env.AUDIT_HASH_SECRET,
      hashAnchorPath,
    });
    const hashes = database
      .prepare(
        "SELECT event_hash AS eventHash, previous_hash AS previousHash " +
          "FROM audit_events ORDER BY id",
      )
      .all() as { eventHash: string; previousHash: string }[];
    const lastHash = writer.getLastHash();
    return { count: hashes.length, lastHash, hashes };
  } finally {
    database.close();
  }
}
