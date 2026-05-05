import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SepoliaRpcProvider } from "./sepolia-provider.js";

let server: ReturnType<typeof createServer>;
let rpcUrl: string;
let chainId: string;
let ethCallError: boolean;
const calls: Array<{ method: string; params: unknown[] }> = [];

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
  chainId = "0xaa36a7";
  ethCallError = false;
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    const params = body.params ?? [];
    calls.push({ method: body.method, params });

    if (body.method === "eth_chainId") {
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: chainId });
      return;
    }
    if (body.method === "eth_call") {
      if (ethCallError) {
        writeJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: 3, message: "execution reverted" },
        });
        return;
      }
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: "0x" });
      return;
    }
    if (body.method === "eth_getBalance") {
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: "0xde0b6b3a7640000" });
      return;
    }
    if (body.method === "eth_blockNumber") {
      writeJson(res, { jsonrpc: "2.0", id: body.id, result: "0xbc614e" });
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

describe("SepoliaRpcProvider", () => {
  it("simulates transactions with eth_call against the configured RPC URL", async () => {
    const provider = new SepoliaRpcProvider({ rpcUrl });

    const result = await provider.simulateTransaction({
      to: "0x0000000000000000000000000000000000000001",
      data: "0x1234",
      value: "10",
    });

    expect(result).toEqual({
      success: true,
      gasUsed: 0,
      balanceChanges: [],
      balanceChangesReliable: false,
      error: null,
    });
    expect(calls).toContainEqual({
      method: "eth_call",
      params: [
        {
          data: "0x1234",
          to: "0x0000000000000000000000000000000000000001",
          value: "0xa",
        },
        "latest",
      ],
    });
  });

  it("fails closed when simulation RPC calls fail", async () => {
    ethCallError = true;
    const provider = new SepoliaRpcProvider({ rpcUrl });

    const result = await provider.simulateTransaction({
      to: "0x0000000000000000000000000000000000000001",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("execution reverted");
  });

  it("fails closed when the configured RPC is not Sepolia", async () => {
    chainId = "0x1";
    const provider = new SepoliaRpcProvider({ rpcUrl });

    const result = await provider.simulateTransaction({
      to: "0x0000000000000000000000000000000000000001",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("expected Sepolia 11155111");
    expect(calls.map((call) => call.method)).not.toContain("eth_call");
  });

  it("rejects balance and block requests when the configured RPC is not Sepolia", async () => {
    chainId = "0x1";
    const provider = new SepoliaRpcProvider({ rpcUrl });

    await expect(provider.getBalance("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      "expected Sepolia 11155111",
    );
    await expect(provider.getBlockNumber()).rejects.toThrow("expected Sepolia 11155111");

    expect(calls.map((call) => call.method)).not.toContain("eth_getBalance");
    expect(calls.map((call) => call.method)).not.toContain("eth_blockNumber");
  });

  it("returns balances and block numbers from Sepolia RPC", async () => {
    const provider = new SepoliaRpcProvider({ rpcUrl });

    await expect(provider.getBalance("0x0000000000000000000000000000000000000001")).resolves.toBe(
      "1000000000000000000",
    );
    await expect(provider.getBlockNumber()).resolves.toBe(12345678);

    expect(calls.map((call) => call.method)).toEqual([
      "eth_chainId",
      "eth_getBalance",
      "eth_chainId",
      "eth_blockNumber",
    ]);
  });
});
