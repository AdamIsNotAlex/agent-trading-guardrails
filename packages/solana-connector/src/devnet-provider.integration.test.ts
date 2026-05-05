import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DevnetSolanaRpcProvider } from "./devnet-provider.js";
import type { ParsedInstruction } from "./interfaces.js";

let server: ReturnType<typeof createServer>;
let rpcUrl: string;
let simulationError: unknown;
let genesisHash: string;
const feePayer = Keypair.generate().publicKey;
const calls: Array<{ method: string; params: unknown[] }> = [];

const instruction: ParsedInstruction = {
  programId: "11111111111111111111111111111111",
  type: "transfer",
  data: { data: "", keys: [] },
};

async function readJson(
  req: IncomingMessage,
): Promise<{ method: string; params?: unknown[]; id?: number }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(async () => {
  calls.length = 0;
  simulationError = null;
  genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    const params = body.params ?? [];
    calls.push({ method: body.method, params });

    if (body.method === "getGenesisHash") {
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: genesisHash });
      return;
    }
    if (body.method === "getLatestBlockhash") {
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          context: { slot: 12345 },
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99999 },
        },
      });
      return;
    }
    if (body.method === "simulateTransaction") {
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          context: { slot: 12345 },
          value: { err: simulationError, logs: ["simulation log"] },
        },
      });
      return;
    }
    if (body.method === "getBalance") {
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { context: { slot: 12345 }, value: 1_000_000_000 },
      });
      return;
    }
    if (body.method === "getSlot") {
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: 12345 });
      return;
    }

    writeJson(res, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `Unsupported method ${body.method}` },
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind.");
  rpcUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("DevnetSolanaRpcProvider", () => {
  it("simulates transactions against the configured RPC URL", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([instruction]);

    expect(result).toEqual({
      success: true,
      logs: ["simulation log"],
      balanceChanges: [],
      error: null,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "getGenesisHash",
      "getLatestBlockhash",
      "simulateTransaction",
    ]);
    const serializedTransaction = Buffer.from(String(calls[2].params[0]), "base64");
    const transaction = VersionedTransaction.deserialize(serializedTransaction);
    expect(transaction.message.staticAccountKeys[0].toBase58()).toBe(feePayer.toBase58());
    expect(calls[2].params[1]).toMatchObject({
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
  });

  it("fails closed when simulation returns an error", async () => {
    simulationError = { InstructionError: [0, "Custom"] };
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([instruction]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("InstructionError");
  });

  it("fails closed when instruction data is malformed", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([
      { ...instruction, data: { ...instruction.data, data: "0xabc" } },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("valid hex");
    expect(calls.map((call) => call.method)).not.toContain("getLatestBlockhash");
    expect(calls.map((call) => call.method)).not.toContain("simulateTransaction");
  });

  it("fails closed when instruction data is not a string", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([
      { ...instruction, data: { ...instruction.data, data: 42 } },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("data must be a string");
    expect(calls.map((call) => call.method)).not.toContain("getLatestBlockhash");
    expect(calls.map((call) => call.method)).not.toContain("simulateTransaction");
  });

  it("fails closed when instruction account metadata is malformed", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([
      { ...instruction, data: { ...instruction.data, keys: [{ pubkey: feePayer.toBase58() }] } },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("flags must be booleans");
    expect(calls.map((call) => call.method)).not.toContain("getLatestBlockhash");
    expect(calls.map((call) => call.method)).not.toContain("simulateTransaction");
  });

  it("fails closed when instruction account metadata is null", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([
      { ...instruction, data: { ...instruction.data, keys: null } },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("keys must be an array");
    expect(calls.map((call) => call.method)).not.toContain("getLatestBlockhash");
    expect(calls.map((call) => call.method)).not.toContain("simulateTransaction");
  });

  it("fails closed when the configured RPC is not devnet", async () => {
    genesisHash = "mainnet-genesis";
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    const result = await provider.simulateTransaction([instruction]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("expected devnet");
    expect(calls.map((call) => call.method)).not.toContain("getLatestBlockhash");
    expect(calls.map((call) => call.method)).not.toContain("simulateTransaction");
  });

  it("rejects balance and slot requests when the configured RPC is not devnet", async () => {
    genesisHash = "mainnet-genesis";
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    await expect(provider.getBalance("11111111111111111111111111111111")).rejects.toThrow(
      "expected devnet",
    );
    await expect(provider.getSlot()).rejects.toThrow("expected devnet");

    expect(calls.map((call) => call.method)).not.toContain("getBalance");
    expect(calls.map((call) => call.method)).not.toContain("getSlot");
  });

  it("returns balances and slots from the configured RPC URL", async () => {
    const provider = new DevnetSolanaRpcProvider({ rpcUrl, feePayer: feePayer.toBase58() });

    await expect(provider.getBalance("11111111111111111111111111111111")).resolves.toBe(
      1_000_000_000,
    );
    await expect(provider.getSlot()).resolves.toBe(12345);

    expect(calls.map((call) => call.method)).toEqual([
      "getGenesisHash",
      "getBalance",
      "getGenesisHash",
      "getSlot",
    ]);
  });
});
