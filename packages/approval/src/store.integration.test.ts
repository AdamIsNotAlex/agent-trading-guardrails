import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "./store.js";

const params = {
  intentId: "persistent-intent",
  correlationId: "persistent-correlation",
  principal: "agent.operator-test",
  action: "cex.place_order",
  resource: "cex:binance:test:ETH-USDC",
  environment: "paper" as const,
  escalationReason: "Human review required",
  approvalType: "one_time" as const,
  intentData: { quantity: 1, nested: { symbol: "ETH-USDC" } },
};

const worker = `
  import { ApprovalStore } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
  const store = new ApprovalStore({ databasePath: process.argv[1], defaultTimeoutSeconds: 300 });
  process.once('message', () => {
    try {
      const result = store[process.argv[3]](process.argv[2], process.argv[3]);
      process.send({ won: result !== null });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      store.close();
      process.disconnect();
    }
  });
  process.send('ready');
`;

let directory: string;
let databasePath: string;
const stores: ApprovalStore[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shared-approval-"));
  databasePath = join(directory, "approvals.db");
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});

function openStore(defaultTimeoutSeconds = 300) {
  const store = new ApprovalStore({ databasePath, defaultTimeoutSeconds });
  stores.push(store);
  return store;
}

async function race(approvalId: string, actions: string[]): Promise<boolean[]> {
  const children: ChildProcess[] = [];
  const jobs = actions.map((action) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", worker, databasePath, approvalId, action],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const result = new Promise<boolean>((resolve, reject) => {
      let value: boolean | undefined;
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message) => {
        if (message === "ready") readyResolve();
        else if (
          message &&
          typeof message === "object" &&
          "won" in message &&
          typeof message.won === "boolean"
        )
          value = message.won;
      });
      child.once("error", (error) => {
        readyReject(error);
        reject(error);
      });
      child.once("exit", (code) => {
        if (code === 0 && value !== undefined) resolve(value);
        else {
          const error = new Error(`Approval worker failed (${code}): ${stderr}`);
          readyReject(error);
          reject(error);
        }
      });
    });
    return { ready, result };
  });
  try {
    const [, results] = await Promise.all([
      Promise.all(jobs.map((job) => job.ready)).then(() => {
        for (const child of children) child.send("go");
      }),
      Promise.all(jobs.map((job) => job.result)),
    ]);
    return results;
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  }
}

describe("shared persistent approvals", () => {
  it("recovers pending requests after reopen and observes an independent operator", async () => {
    const creator = openStore();
    const request = creator.create(params);
    creator.close();
    const observer = openStore();
    expect(observer.get(request.approvalId)).toEqual(request);
    const waiting = observer.waitForApproval(request.approvalId, 5000, 10);
    expect(await race(request.approvalId, ["approve"])).toEqual([true]);
    const decision = await waiting;
    expect(decision).toMatchObject({ state: "approved", decidedBy: "approve" });
    observer.close();
    expect(openStore().get(request.approvalId)).toEqual(decision);
  });

  it("allows only one concurrent decision and one consumer across processes", async () => {
    const observer = openStore();
    const disputed = observer.create(params);
    const actions = ["approve", "deny", "approve", "deny"];
    const decisions = await race(disputed.approvalId, actions);
    expect(decisions.filter(Boolean)).toEqual([true]);
    const winner = actions[decisions.indexOf(true)];
    expect(observer.get(disputed.approvalId)).toMatchObject({
      state: winner === "approve" ? "approved" : "denied",
      decidedBy: winner,
    });

    const approved = observer.create({ ...params, intentId: "single-use" });
    observer.approve(approved.approvalId, "operator");
    const consumed = await race(approved.approvalId, Array(4).fill("consumeOneTime"));
    expect(consumed.filter(Boolean)).toEqual([true]);
    observer.close();
    const restarted = openStore();
    expect(restarted.get(approved.approvalId)).toMatchObject({
      state: "consumed",
      decidedBy: "operator",
    });
    expect(restarted.consumeOneTime(approved.approvalId)).toBeNull();
  });

  it("persists expiration and ignores mutations to returned request snapshots", async () => {
    const store = openStore(-1);
    const request = store.create(params);
    request.timeoutAt = new Date(Date.now() + 300_000).toISOString();
    request.intentData.quantity = 999;
    const snapshot = store.get(request.approvalId);
    expect(snapshot?.intentData.quantity).toBe(1);
    expect(snapshot?.timeoutAt).not.toBe(request.timeoutAt);
    const [decision] = await race(request.approvalId, ["approve"]);
    expect(decision).toBe(false);
    store.close();
    expect(openStore().get(request.approvalId)).toMatchObject({
      state: "timeout",
      decidedBy: null,
      intentData: { quantity: 1 },
    });
  });
});
