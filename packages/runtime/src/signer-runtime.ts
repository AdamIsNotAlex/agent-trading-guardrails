import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { AuditWriter } from "@guardrails/audit";
import { createGuardrailDecisionToken } from "@guardrails/broker";
import { decodeTransaction, isUnlimitedApproval } from "@guardrails/evm-connector";
import {
  getRequestCorrelationId,
  HttpError,
  loadDevConfig,
  readJsonBody,
  sendJson,
} from "@guardrails/service";
import Database from "better-sqlite3";
import { type Address, type Hex, isAddress, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Runtime } from "./runtime.js";
import {
  OfflineSignature,
  SigningRequest,
  UnsignedDecimal,
  verifyOfflineSignature,
} from "./signer-request.js";

const decisionMaxAgeMs = 300_000;

function readKey(path: string): Hex {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const created = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(created, `${generatePrivateKey()}\n`);
      fsyncSync(created);
    } finally {
      closeSync(created);
    }
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > 67 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new Error("Signer key must be an owner-only regular file owned by the signer user.");
    }
    const key = readFileSync(descriptor, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Signer key file is invalid.");
    return key as Hex;
  } finally {
    closeSync(descriptor);
  }
}

function cap(name: string, fallback: string): bigint {
  const parsed = UnsignedDecimal.safeParse(process.env[name] ?? fallback);
  if (!parsed.success || BigInt(parsed.data) === 0n)
    throw new Error(`${name} must be a positive uint256 decimal.`);
  return BigInt(parsed.data);
}

export function createSignerRuntime(): Runtime {
  const config = loadDevConfig();
  if (config.environment !== "dev" && config.environment !== "paper") {
    throw new Error(
      "The local offline signer requires GUARDRAIL_ENV=dev or paper; never fund its keys.",
    );
  }
  const secret = config.decisionSigningSecret;
  if (
    !secret.length ||
    (config.environment !== "dev" && (secret === "dev-decision-secret" || secret.length < 32))
  ) {
    throw new Error("Signer requires a decision secret, at least 32 characters outside dev.");
  }
  const maxGas = cap("SIGNER_MAX_GAS", "1000000");
  const maxFeePerGas = cap("SIGNER_MAX_FEE_PER_GAS", "100000000000");
  const maxTotalFee = cap("SIGNER_MAX_TOTAL_FEE_WEI", "10000000000000000");
  const account = privateKeyToAccount(
    readKey(process.env.SIGNER_KEY_PATH ?? "./data/signer/sepolia.key"),
  );
  const dbPath = process.env.SIGNER_AUDIT_DB_PATH ?? "./data/signer-audit.db";
  const anchorPath = process.env.SIGNER_AUDIT_HASH_ANCHOR_PATH ?? "./audit-anchor/signer/head.hash";
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(anchorPath), { recursive: true, mode: 0o700 });
  const database = new Database(dbPath);
  try {
    const audit = new AuditWriter(database, {
      environment: config.environment,
      hashAnchorPath: anchorPath,
    });
    database.exec(`
      CREATE TABLE IF NOT EXISTS signer_identity (id INTEGER PRIMARY KEY CHECK (id = 1), address TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signer_requests (
        idempotency_key TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE,
        nonce INTEGER NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        response TEXT
      );
    `);
    database
      .prepare("INSERT OR IGNORE INTO signer_identity (id, address) VALUES (1, ?)")
      .run(account.address);
    const identity = database.prepare("SELECT address FROM signer_identity WHERE id = 1").get() as {
      address: string;
    };
    if (identity.address !== account.address)
      throw new Error("Signer key does not match its durable signing state.");
    const find = database.prepare(
      "SELECT request_hash, response FROM signer_requests WHERE idempotency_key = ?",
    );
    const reserve = database.prepare(
      "INSERT OR IGNORE INTO signer_requests (idempotency_key, intent_id, nonce, request_hash) VALUES (?, ?, ?, ?)",
    );
    const complete = database.prepare(
      "UPDATE signer_requests SET response = ? WHERE idempotency_key = ? AND response IS NULL",
    );

    async function sign(request: SigningRequest): Promise<OfflineSignature> {
      const { approval, transaction } = request;
      const intent = approval.intent;
      const expected = createGuardrailDecisionToken({ ...approval, secret });
      if (
        !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(approval.decisionToken, "hex"))
      ) {
        throw new HttpError(403, "Guardrail decision token is invalid.");
      }
      const age = Date.now() - Date.parse(approval.decidedAt);
      if (age < 0 || age > decisionMaxAgeMs)
        throw new HttpError(403, "Guardrail decision is stale or future-dated.");
      if (approval.intentId !== intent.intentId || intent.environment !== config.environment) {
        throw new HttpError(403, "Approval does not match signer environment or intent.");
      }
      if (
        intent.action !== "onchain.request_signature" ||
        intent.chain !== "ethereum" ||
        intent.chainEnvironment !== "sepolia"
      ) {
        throw new HttpError(403, "Only authorized Ethereum Sepolia signing intents are accepted.");
      }
      if (
        !isAddress(intent.to) ||
        intent.resource !== `onchain:ethereum:sepolia:${intent.to}` ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(intent.data ?? "0x") ||
        !UnsignedDecimal.safeParse(intent.value ?? "0").success
      ) {
        throw new HttpError(400, "Invalid transaction destination, resource, calldata, or value.");
      }
      const decoded = decodeTransaction(intent.to, intent.data, intent.value);
      if (
        decoded.functionSelector === "0x095ea7b3" &&
        (!decoded.isApproval ||
          isUnlimitedApproval(decoded) ||
          !intent.maxTokenApprovalAmount ||
          BigInt(intent.maxTokenApprovalAmount) === (1n << 256n) - 1n ||
          BigInt(decoded.approvalAmount ?? "0") > BigInt(intent.maxTokenApprovalAmount))
      ) {
        throw new HttpError(
          403,
          "Token approval is malformed, unlimited, or exceeds its authorized cap.",
        );
      }
      const gas = BigInt(transaction.gas);
      const fee = BigInt(transaction.maxFeePerGas);
      const priority = BigInt(transaction.maxPriorityFeePerGas);
      if (
        gas < 21000n ||
        gas > maxGas ||
        fee === 0n ||
        fee > maxFeePerGas ||
        priority > fee ||
        gas * fee > maxTotalFee
      ) {
        throw new HttpError(403, "Transaction exceeds signer gas or fee limits.");
      }
      const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const existing = find.get(intent.idempotencyKey) as
        | { request_hash: string; response: string | null }
        | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash || existing.response === null) {
          throw new HttpError(
            409,
            "Signing authorization is already bound or has an unresolved attempt.",
          );
        }
        const cached = OfflineSignature.parse(JSON.parse(existing.response));
        await verifyOfflineSignature(request, cached, account.address);
        return cached;
      }
      if (
        reserve.run(intent.idempotencyKey, intent.intentId, transaction.nonce, requestHash)
          .changes !== 1
      ) {
        throw new HttpError(409, "Intent or nonce has already been reserved for signing.");
      }
      const event = {
        environment: config.environment,
        correlationId: approval.correlationId,
        intentId: intent.intentId,
        principal: intent.principal,
      };
      audit.write({
        ...event,
        eventType: "signer.requested",
        data: { signerBackend: "local-offline-sepolia", nonce: transaction.nonce },
      });
      const signedTransaction = await account.signTransaction({
        type: "eip1559",
        chainId: 11155111,
        to: intent.to as Address,
        data: (intent.data ?? "0x") as Hex,
        value: BigInt(intent.value ?? "0"),
        nonce: transaction.nonce,
        gas,
        maxFeePerGas: fee,
        maxPriorityFeePerGas: priority,
      });
      const result: OfflineSignature = {
        mode: "offline-sepolia",
        chainId: 11155111,
        intentId: intent.intentId,
        address: account.address,
        signedTransaction,
        transactionHash: keccak256(signedTransaction),
      };
      // Reserve before signing; audit before publishing the durable result. A crash/error
      // leaves an unresolved reservation, never an authorization that can sign another nonce.
      audit.write({
        ...event,
        eventType: "signer.completed",
        data: { signerBackend: result.mode, transactionHash: result.transactionHash },
      });
      if (complete.run(JSON.stringify(result), intent.idempotencyKey).changes !== 1)
        throw new Error("Signing result persistence failed.");
      return result;
    }

    const server = createServer((request, response) => {
      let correlationId = randomUUID() as string;
      let signing = false;
      let parsed: SigningRequest | undefined;
      const handle = async () => {
        try {
          correlationId = getRequestCorrelationId(request);
          response.setHeader("x-correlation-id", correlationId);
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          const method = path === "/health" ? "GET" : path === "/sign" ? "POST" : null;
          if (!method) throw new HttpError(404, "Route not found.");
          if (request.method !== method) {
            response.setHeader("allow", method);
            throw new HttpError(405, "Method not allowed.");
          }
          if (path === "/health") {
            sendJson(response, 200, {
              status: "ok",
              mode: "offline-sepolia",
              chainId: 11155111,
              address: account.address,
            });
            return;
          }
          signing = true;
          const body = SigningRequest.safeParse(await readJsonBody(request));
          if (!body.success) throw new HttpError(400, "Invalid signing request.");
          parsed = body.data;
          sendJson(response, 200, await sign(parsed));
        } catch (error) {
          let status = error instanceof HttpError ? error.statusCode : 500;
          let message = error instanceof HttpError ? error.message : "Internal server error.";
          if (signing) {
            try {
              audit.write({
                eventType: "signer.failed",
                environment: config.environment,
                correlationId: parsed?.approval.correlationId ?? correlationId,
                intentId: parsed?.approval.intentId,
                data: { error: message },
              });
            } catch {
              status = 500;
              message = "Internal server error.";
            }
          }
          response.setHeader("x-correlation-id", correlationId);
          sendJson(response, status, { error: message, correlationId });
        } finally {
          request.resume();
        }
      };
      void handle();
    });
    return { server, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
