import { createServer } from "node:http";
import type { OnchainSigningIntent } from "@guardrails/schemas";
import { ethereumSepoliaSigning } from "@guardrails/schemas/fixtures";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toHex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvmConnector } from "./connector.js";
import type { EvmConfig } from "./interfaces.js";
import { EvmJsonRpcProvider } from "./rpc-provider.js";

const sender: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const recipient: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const token: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const stranger: Address = "0x1111111111111111111111111111111111111111";
const senderSlot = "0x723077b8a1b173adc35e5f0e7e3662fd1208212cb629f9c128551ea7168da722";
const recipientSlot = "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101";
const zero = toHex(0n, { size: 32 });
const word = (amount: bigint) => toHex(amount, { size: 32 });
const data = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [recipient, 100n],
});
const nativeBalance = 1_000_000n;
const blockHash = `0x${"ab".repeat(32)}`;
const sepoliaChainIdHex = "0xaa36a7";
const mainnetChainIdHex = "0x1";
interface TraceAccount {
  balance?: string | number;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
}
let server: ReturnType<typeof createServer>;
let rpcUrl: string;
let chainId: string;
let trace: { pre: Record<string, TraceAccount>; post: Record<string, TraceAccount> };
let unsupportedTrace: boolean;
let revert: boolean;
let reorg: boolean;
let wrongPreBalance: boolean;
let wrongPostBalance: boolean;
let malformedBalance: boolean;
let pinnedStorage: Record<string, string>;

beforeEach(async () => {
  chainId = sepoliaChainIdHex;
  unsupportedTrace = false;
  revert = false;
  reorg = false;
  wrongPreBalance = false;
  wrongPostBalance = false;
  malformedBalance = false;
  pinnedStorage = { [senderSlot]: word(1000n) };
  // Canonical sparse prestateTracer shape captured from a real Geth-compatible EVM.
  trace = {
    pre: {
      [sender]: { balance: toHex(nativeBalance), nonce: 1 },
      [token]: { balance: "0x0", code: "0x6000", nonce: 1, storage: { [senderSlot]: word(1000n) } },
    },
    post: {
      [sender]: { nonce: 2 },
      [token]: { storage: { [senderSlot]: word(900n), [recipientSlot]: word(100n) } },
    },
  };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const params = body.params ?? [];
    let result: unknown;
    if (body.method === "eth_chainId") result = chainId;
    else if (body.method === "eth_getBlockByNumber")
      result = {
        number: "0x7b",
        hash: reorg && params[0] !== "latest" ? `0x${"cd".repeat(32)}` : blockHash,
      };
    else if (body.method === "eth_blockNumber") result = "0x7b";
    else if (body.method === "debug_traceCall" && !unsupportedTrace) {
      result =
        params[2].tracer === "callTracer"
          ? {
              from: params[0].from,
              to: params[0].to,
              gasUsed: "0xc350",
              ...(revert ? { error: "execution reverted" } : {}),
            }
          : trace;
    } else if (body.method === "eth_getBalance")
      result = params[0] === sender ? toHex(nativeBalance) : "0x0";
    else if (body.method === "eth_getStorageAt") result = pinnedStorage[params[1]] ?? zero;
    else if (body.method === "eth_call") {
      const account = `0x${params[0].data.slice(-40)}` as Address;
      const slot = keccak256(
        encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 0n]),
      );
      const after = params[2]?.[token]?.stateDiff;
      let amount = BigInt(after?.[slot] ?? pinnedStorage[slot] ?? zero);
      if (wrongPreBalance && !params[2] && account === sender) amount++;
      if (wrongPostBalance && params[2] && account === sender) amount++;
      result = malformedBalance ? "0x01" : word(amount);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        result === undefined
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unsupported RPC" } }
          : { jsonrpc: "2.0", id: body.id, result },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing RPC listener.");
  rpcUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function config(chainEnvironment: EvmConfig["chainEnvironment"] = "sepolia"): EvmConfig {
  return {
    rpcUrl,
    chainId: chainEnvironment === "mainnet" ? 1 : 11155111,
    chainEnvironment,
    fromAddress: recipient,
    allowedContracts: [token],
    allowedFunctions: ["transfer"],
    allowedTokens: [token],
    allowedSpenders: [],
    allowedRecipients: [recipient],
    erc20Tokens: [{ address: token, asset: token, balanceSlot: "0" }],
  };
}
function provider(chainEnvironment: EvmConfig["chainEnvironment"] = "sepolia") {
  return new EvmJsonRpcProvider(config(chainEnvironment));
}
const request = { from: sender, to: token, data, observedAddresses: [recipient] };
const tokenTransferChanges = [
  { address: sender, asset: token, delta: "-100" },
  { address: recipient, asset: token, delta: "100" },
  { address: sender, asset: "ETH", delta: "0" },
];

describe("EvmJsonRpcProvider execution state evidence", () => {
  it("attests ERC20 debit/credit and unchanged native balances from sparse state diffs", async () => {
    const result = await provider().simulateTransaction(request);
    expect(result.success && result.balanceChangesReliable).toBe(true);
    expect(result.gasUsed).toBe(50000);
    expect(result.balanceChanges).toEqual(expect.arrayContaining(tokenTransferChanges));
  });
  it("attests ERC20 debit/credit on mainnet only when RPC reports chain ID 1", async () => {
    chainId = mainnetChainIdHex;
    const result = await provider("mainnet").simulateTransaction(request);
    expect(result.success && result.balanceChangesReliable).toBe(true);
    expect(result.gasUsed).toBe(50000);
    expect(result.balanceChanges).toEqual(expect.arrayContaining(tokenTransferChanges));
    chainId = sepoliaChainIdHex;
    const mismatched = await provider("mainnet").simulateTransaction(request);
    expect(mismatched.success).toBe(false);
    expect(mismatched.balanceChangesReliable).toBe(false);
    expect(mismatched.balanceChanges).toEqual([]);
  });
  it("attests native value movement to newly created accounts", async () => {
    trace = {
      pre: { [sender]: { balance: toHex(nativeBalance), nonce: 1 } },
      post: {
        [sender]: { balance: toHex(nativeBalance - 10n), nonce: 2 },
        [recipient]: { balance: "0xa" },
      },
    };
    const result = await new EvmJsonRpcProvider({
      rpcUrl,
      chainEnvironment: "sepolia",
    }).simulateTransaction({
      from: sender,
      to: recipient,
      value: "10",
    });
    expect(result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { address: sender, asset: "ETH", delta: "-10" },
        { address: recipient, asset: "ETH", delta: "10" },
      ]),
    );
  });
  it("preserves token precision and treats a deleted storage slot as zero", async () => {
    pinnedStorage[senderSlot] = word(9_007_199_254_740_993n);
    trace.pre[token].storage = { [senderSlot]: pinnedStorage[senderSlot] };
    trace.post[token].storage = { [recipientSlot]: pinnedStorage[senderSlot] };
    const result = await provider().simulateTransaction(request);
    expect(result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { address: sender, asset: token, delta: "-9007199254740993" },
        { address: recipient, asset: token, delta: "9007199254740993" },
      ]),
    );
  });
  it.each([
    "unsupported",
    "revert",
    "empty",
    "unknown-storage",
    "unobserved-account",
    "pre-mismatch",
    "post-mismatch",
    "bad-word",
    "unsafe-integer",
    "reorg",
    "wrong-chain",
  ])("refuses %s evidence", async (mode) => {
    if (mode === "unsupported") unsupportedTrace = true;
    if (mode === "revert") revert = true;
    if (mode === "empty") trace = { pre: {}, post: {} };
    if (mode === "unknown-storage") trace.post[token].storage = { [word(7n)]: word(1n) };
    if (mode === "unobserved-account")
      trace.post[token].storage = {
        [senderSlot]: word(900n),
        [keccak256(
          encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [stranger, 0n]),
        )]: word(100n),
      };
    if (mode === "pre-mismatch") wrongPreBalance = true;
    if (mode === "post-mismatch") wrongPostBalance = true;
    if (mode === "bad-word") malformedBalance = true;
    if (mode === "unsafe-integer") trace.pre[sender].balance = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "reorg") reorg = true;
    if (mode === "wrong-chain") chainId = mainnetChainIdHex;
    const result = await provider().simulateTransaction(request);
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it.each([
    { configured: "sepolia" as const, rpcChainId: mainnetChainIdHex },
    { configured: "mainnet" as const, rpcChainId: sepoliaChainIdHex },
  ])("refuses $configured evidence when RPC reports another network", async ({
    configured,
    rpcChainId,
  }) => {
    chainId = rpcChainId;
    const result = await provider(configured).simulateTransaction(request);
    expect(result.success).toBe(false);
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it("does not guess an unconfigured token's storage layout", async () => {
    const result = await new EvmJsonRpcProvider({
      rpcUrl,
      chainEnvironment: "sepolia",
    }).simulateTransaction(request);
    expect(result.balanceChangesReliable).toBe(false);
  });
  it("retains exact zero token observations for explicit unchanged-balance expectations", async () => {
    trace = {
      pre: { [sender]: { balance: toHex(nativeBalance), nonce: 1 } },
      post: { [sender]: { nonce: 2 } },
    };
    const result = await provider().simulateTransaction(request);
    expect(result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toContainEqual({ address: sender, asset: token, delta: "0" });
  });
  it("returns balances and block numbers only on the configured network", async () => {
    await expect(provider().getBalance(sender)).resolves.toBe(nativeBalance.toString());
    await expect(provider().getBlockNumber()).resolves.toBe(123);
    chainId = mainnetChainIdHex;
    await expect(provider().getBalance(sender)).rejects.toThrow();
    await expect(provider().getBlockNumber()).rejects.toThrow();
    await expect(provider("mainnet").getBalance(sender)).resolves.toBe(nativeBalance.toString());
    await expect(provider("mainnet").getBlockNumber()).resolves.toBe(123);
    chainId = sepoliaChainIdHex;
    await expect(provider("mainnet").getBalance(sender)).rejects.toThrow();
    await expect(provider("mainnet").getBlockNumber()).rejects.toThrow();
  });
});

describe("EvmJsonRpcProvider network configuration", () => {
  it("rejects an unsupported chain environment", () => {
    expect(
      () =>
        new EvmJsonRpcProvider({
          rpcUrl,
          chainEnvironment: "goerli" as EvmConfig["chainEnvironment"],
        }),
    ).toThrow("Unsupported Ethereum chain environment");
  });
  it.each([
    { chainEnvironment: "sepolia" as const, chainId: 1 },
    { chainEnvironment: "mainnet" as const, chainId: 11155111 },
  ])("rejects chainId $chainId for $chainEnvironment", ({ chainEnvironment, chainId }) => {
    expect(() => new EvmJsonRpcProvider({ rpcUrl, chainEnvironment, chainId })).toThrow("chain ID");
  });
  it("accepts an optional chainId that matches the configured network", () => {
    expect(() => new EvmJsonRpcProvider(config("sepolia"))).not.toThrow();
    expect(() => new EvmJsonRpcProvider(config("mainnet"))).not.toThrow();
  });
});

describe("built-in EVM provider signing boundary", () => {
  function signing(chainEnvironment: EvmConfig["chainEnvironment"] = "sepolia") {
    const signAndBroadcast = vi.fn(async () => "accepted-by-signer");
    const connector = new EvmConnector(config(chainEnvironment), provider(chainEnvironment), {
      getAddress: () => sender,
      signAndBroadcast,
    });
    const intent: Extract<OnchainSigningIntent, { chain: "ethereum" }> = {
      ...ethereumSepoliaSigning,
      chain: "ethereum",
      chainEnvironment,
      environment: chainEnvironment === "mainnet" ? "production" : "testnet",
      resource: `onchain:ethereum:${chainEnvironment}:${token}`,
      to: token,
      data,
      expectedDeltas: [
        { address: sender, asset: token, minDelta: "-100", maxDelta: "-100" },
        { address: recipient, asset: token, minDelta: "100", maxDelta: "100" },
      ],
    };
    return { connector, intent, signAndBroadcast };
  }
  it("uses the real signer instead of the configured simulation account and reaches signing", async () => {
    const { connector, intent, signAndBroadcast } = signing();
    await expect(connector.execute(intent)).resolves.toEqual({
      transactionHash: "accepted-by-signer",
    });
    expect(signAndBroadcast).toHaveBeenCalledOnce();
  });
  it("reaches signing on mainnet through the injected signer when RPC reports chain ID 1", async () => {
    chainId = mainnetChainIdHex;
    const { connector, intent, signAndBroadcast } = signing("mainnet");
    await expect(connector.execute(intent)).resolves.toEqual({
      transactionHash: "accepted-by-signer",
    });
    expect(signAndBroadcast).toHaveBeenCalledOnce();
  });
  it.each(["range", "unexpected-debit", "unreliable"])("never signs %s", async (mode) => {
    const { connector, intent, signAndBroadcast } = signing();
    if (mode === "range") intent.expectedDeltas[1].minDelta = "101";
    if (mode === "unexpected-debit") intent.expectedDeltas.shift();
    if (mode === "unreliable") unsupportedTrace = true;
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });
  it.each([
    { configured: "sepolia" as const, rpcChainId: mainnetChainIdHex },
    { configured: "mainnet" as const, rpcChainId: sepoliaChainIdHex },
  ])("never signs $configured when RPC reports another network", async ({
    configured,
    rpcChainId,
  }) => {
    chainId = rpcChainId;
    const { connector, intent, signAndBroadcast } = signing(configured);
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });
});
