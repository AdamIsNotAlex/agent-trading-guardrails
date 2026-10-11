#!/usr/bin/env node
// Own a disposable Compose project. Never reuse or remove an operator's stack/volumes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `guardrails-acceptance-${randomUUID().slice(0, 8)}`;
const temporary = await mkdtemp(join(tmpdir(), `${project}-`));
const configPath = join(temporary, "compose.json");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: "",
  COMPOSE_DISABLE_ENV_FILE: "true",
  COMPOSE_PARALLEL_LIMIT: "1",
  GUARDRAIL_ENV: "dev",
  OPENAI_API_KEY: "offline-container-acceptance-not-a-real-key",
  REVIEWER_PROVIDER: "openai",
  REVIEWER_MODEL: "gpt-5.5",
  GUARDRAIL_DECISION_SECRET: randomUUID(),
  AUDIT_HASH_SECRET: randomUUID(),
  BROKER_KILL_SWITCH: "false",
  APPROVAL_TIMEOUT_SECONDS: "300",
  SIGNER_MAX_GAS: "1000000",
  SIGNER_MAX_FEE_PER_GAS: "100000000000",
  SIGNER_MAX_TOTAL_FEE_WEI: "10000000000000000",
};
let child;
let interrupted = false;
let created = false;

function interrupt() {
  interrupted = true;
  child?.kill("SIGTERM");
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

function run(command, args, { capture = false, allowFailure = false, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      timeout,
      killSignal: "SIGKILL",
    });
    child = process;
    let stdout = "";
    let stderr = "";
    process.stdout?.on("data", (data) => { stdout += data; });
    process.stderr?.on("data", (data) => { stderr += data; });
    process.once("error", reject);
    process.once("close", (code, signal) => {
      child = undefined;
      const output = stdout + stderr;
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${output}`));
      } else {
        resolve({ code, stdout, output });
      }
    });
  });
}

const compose = (args, options) => run("docker", [
  "compose", "--project-name", project, "--project-directory", root,
  "--env-file", "/dev/null", "--file", configPath, ...args,
], options);

try {
  // Normalize the real deployment, retaining its security rules, images and dependency graph.
  // Remove only host publications: probes use exec and must not steal another project's ports.
  const resolved = await run("docker", [
    "compose", "--project-name", project, "--project-directory", root,
    "--env-file", "/dev/null", "--file", join(root, "docker-compose.yml"),
    "config", "--format", "json",
  ], { capture: true });
  const config = JSON.parse(resolved.stdout);
  for (const service of Object.values(config.services)) delete service.ports;
  config.services.agent.image = `${project}-agent`;
  const hardened = {
    image: config.services.agent.image,
    init: true,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 32,
    mem_limit: "128m",
    networks: { "agent-net": {} },
  };
  // An actually listening forbidden peer distinguishes a firewall drop from a dead endpoint.
  config.services["egress-witness"] = {
    ...hardened,
    networks: { "agent-net": { ipv4_address: "172.30.10.250" } },
    command: ["node", "--input-type=module", "-e", `
      import { createServer } from 'node:http';
      import { createSocket } from 'node:dgram';
      createServer((request, response) => response.end('acceptance-witness')).listen(9090, '0.0.0.0');
      const socket = createSocket('udp4');
      socket.on('message', (message, peer) => socket.send(message, peer.port, peer.address));
      socket.bind(9091, '0.0.0.0');
    `],
    healthcheck: {
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9090').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      interval: "2s", timeout: "3s", retries: 15,
    },
  };
  config.services["egress-control"] = {
    ...hardened,
    command: ["node", "-e", "setInterval(() => {}, 60000)"],
    depends_on: { "egress-witness": { condition: "service_healthy" } },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  env.COMPOSE_FILE = configPath;
  await compose(["config", "--quiet"]);
  if (interrupted) throw new Error("Container acceptance interrupted before startup.");
  created = true; // Also clean partially built/started resources after failure.
  await compose(["build"], { timeout: 1_200_000 });
  if (interrupted) throw new Error("Container acceptance interrupted during build.");
  // Docker itself atomically rejects overlapping fixed subnets; no host-global firewall changes.
  await compose(["up", "--no-build", "--pull", "missing", "-d", "--wait", "--wait-timeout", "120"], {
    timeout: 180_000,
  });
  await run(process.execPath, ["deploy/verify-local.mjs", "--witness"]);
  if (interrupted) throw new Error("Container acceptance interrupted during verification.");

  // Fault injection only in this disposable namespace: the same verifier must detect a bypass.
  await compose(["exec", "-T", "agent-sandbox", "nft", "insert", "rule", "inet", "guardrails",
    "output", "ip", "daddr", "172.30.10.250", "tcp", "dport", "9090", "accept"]);
  const bypass = await run(process.execPath, ["deploy/verify-local.mjs", "--witness"], {
    capture: true, allowFailure: true,
  });
  assert.notEqual(bypass.code, 0, "Verifier accepted an intentionally opened egress path");
  assert.match(bypass.output, /Isolation bypass: controlled TCP witness/);
  console.log("Container acceptance: live TCP/UDP controls, namespace drops and fresh logs verified; intentional bypass detected");
} catch (error) {
  if (created) await compose(["logs", "--no-color", "--tail", "100"], { allowFailure: true });
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  // This random project and its volumes were created exclusively by this invocation.
  if (created) {
    try {
      await compose(["down", "--volumes", "--remove-orphans", "--rmi", "local", "--timeout", "5"]);
    } catch (error) {
      console.error(`Cleanup failed for ${project}:`, error);
      process.exitCode = 1;
    }
  }
  await rm(temporary, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
