import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Pause the real compiled store inside its critical section, not a mock lock/store.
const worker = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { FileBrokerIdempotencyStore } from ${JSON.stringify(new URL("../dist/idempotency-store.js", import.meta.url).href)};
  const [path, pauseAt, intentJson] = process.argv.slice(1);
  const intent = JSON.parse(intentJson);
  function pause() {
    process.send("paused");
    process.kill(process.pid, "SIGSTOP");
  }
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    const result = read.call(this, file, ...args);
    if (file === path && pauseAt === "read") pause();
    return result;
  };
  const fsync = fs.fsyncSync;
  fs.fsyncSync = function(fd) {
    fsync(fd);
    if (pauseAt === "written" && fs.fstatSync(fd).isDirectory()) pause();
  };
  syncBuiltinESMExports();
  try {
    const reservation = new FileBrokerIdempotencyStore(path).begin(intent.idempotencyKey, intent);
    if (reservation.status === "pending") {
      await reservation.result.catch(() => {});
    }
    process.send({ status: reservation.status });
  } catch (error) {
    process.send({ status: "error", code: error.code, message: error.message });
  }
  process.disconnect();
`;

type WorkerResult = { status: string; code?: string; message?: string };
type PauseAt = "none" | "read" | "written";

// SIGSTOP/SIGCONT plus /proc let the test confirm suspension before contending.
describe.skipIf(process.platform !== "linux")("cross-process idempotency locking", () => {
  let directory: string;
  let path: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "idempotency-lock-"));
    path = join(directory, "store.json");
    writeFileSync(path, JSON.stringify({ entries: {} }));
  });

  async function killWorker(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }

  afterEach(async () => {
    await Promise.all(children.splice(0).map(killWorker));
    rmSync(directory, { recursive: true, force: true });
  });

  function startWorker(pauseAt: PauseAt = "none") {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", worker, path, pauseAt, JSON.stringify(binanceSpotOrder)],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let response: WorkerResult | undefined;
    child.on("message", (message) => {
      if (message && typeof message === "object" && "status" in message) {
        response = message as WorkerResult;
      }
    });
    const result = (async () => {
      const [code, signal] = await once(child, "close");
      if (code !== 0 || !response) {
        throw new Error(`Idempotency worker failed (${code ?? signal}): ${stderr}`);
      }
      return response;
    })();
    const paused =
      pauseAt === "none"
        ? Promise.resolve()
        : once(child, "message", { signal: AbortSignal.timeout(5_000) }).then(async ([message]) => {
            expect(message).toBe("paused");
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              if (/^State:\s+T/m.test(readFileSync(`/proc/${child.pid}/status`, "utf8"))) return;
              await delay(10);
            }
            throw new Error("Idempotency worker did not stop.");
          });
    // Cleanup intentionally kills stopped workers, including after an assertion fails.
    result.catch(() => {});
    paused.catch(() => {});
    return { child, result, paused };
  }

  it("does not expire a suspended owner's lock or grant a second reservation", async () => {
    const holder = startWorker("read");
    await holder.paused;
    const lockPath = `${path}.lock`;
    const old = new Date(Date.now() - 31_000);
    utimesSync(lockPath, old, old);
    // Also age the former protocol's owner file so this reproduces its lease expiry.
    if (existsSync(`${lockPath}/owner`)) utimesSync(`${lockPath}/owner`, old, old);

    expect(await startWorker().result).toMatchObject({ status: "error", code: "SQLITE_BUSY" });
    holder.child.kill("SIGCONT");
    expect(await holder.result).toEqual({ status: "reserved" });
    expect(await startWorker().result).toEqual({ status: "pending" });
  });

  it("grants exactly one reservation when processes race to create the mutex", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => startWorker().result));
    expect(results.map((result) => result.status).sort()).toEqual([
      "pending",
      "pending",
      "pending",
      "reserved",
    ]);
  });

  it.each([
    "read",
    "written",
  ] as const)("releases a killed owner's lock after %s without losing persisted reservations", async (pauseAt) => {
    const holder = startWorker(pauseAt);
    await holder.paused;
    await killWorker(holder.child);

    expect(await startWorker().result).toEqual({
      status: pauseAt === "read" ? "reserved" : "pending",
    });
    expect(await startWorker().result).toEqual({ status: "pending" });
  });
});
