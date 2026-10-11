import { createServer } from "node:http";
import type { OnchainSigningIntent } from "@guardrails/schemas";
import { solanaDevnetSigning } from "@guardrails/schemas/fixtures";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaConnector } from "./connector.js";
import type { SolanaConfig } from "./interfaces.js";
import { parseInstructions } from "./parser.js";
import { SolanaJsonRpcProvider } from "./rpc-provider.js";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const payer = key(1);
const recipient = key(2);
const source = key(3);
const destination = key(4);
const mint = key(5);
const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
interface RpcAccount {
  lamports: number;
  owner: string;
  executable: boolean;
  rentEpoch: number;
  data: [string, string];
}
function account(lamports: number, data = Buffer.alloc(0), owner = SYSTEM): RpcAccount {
  return {
    lamports,
    owner,
    executable: false,
    rentEpoch: 0,
    data: [data.toString("base64"), "base64"],
  };
}
function tokenAccount(amount: bigint, owner = TOKEN): RpcAccount {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data);
  payer.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return account(2_039_280, data, owner);
}
function mintAccount(owner = TOKEN): RpcAccount {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return account(1_461_600, data, owner);
}
function raw(instruction: TransactionInstruction): Record<string, unknown> {
  return {
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map((meta) => ({ ...meta, pubkey: meta.pubkey.toBase58() })),
    data: instruction.data.toString("base64"),
  };
}
const transfer = raw(
  SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 100 }),
);
function tokenTransfer(program = TOKEN): Record<string, unknown> {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(100n, 1);
  data[9] = 6;
  return raw(
    new TransactionInstruction({
      programId: new PublicKey(program),
      data,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: false },
      ],
    }),
  );
}
let server: ReturnType<typeof createServer>;
let rpcUrl: string;
let genesis: string;
let simulationSlot: number;
let simulationError: unknown;
let missingPost: boolean;
let truncatePost: boolean;
let unsupportedSnapshot: boolean;
let pre: Map<string, RpcAccount | null>;
let post: Map<string, RpcAccount | null>;

beforeEach(async () => {
  genesis = DEVNET_GENESIS;
  simulationSlot = 12345;
  simulationError = null;
  missingPost = false;
  truncatePost = false;
  unsupportedSnapshot = false;
  pre = new Map([
    [payer.toBase58(), account(1_000_000_000)],
    [recipient.toBase58(), account(1000)],
    [SYSTEM, { ...account(1), executable: true }],
    [TOKEN, { ...account(1), executable: true }],
    [TOKEN_2022, { ...account(1), executable: true }],
  ]);
  post = new Map(pre);
  post.set(payer.toBase58(), account(999_994_900));
  post.set(recipient.toBase58(), account(1100));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const params = body.params ?? [];
    let result: unknown;
    if (body.method === "getGenesisHash") result = genesis;
    else if (body.method === "getLatestBlockhash")
      result = {
        context: { slot: 12345 },
        value: { blockhash: SYSTEM, lastValidBlockHeight: 99999 },
      };
    else if (body.method === "getMultipleAccounts" && !unsupportedSnapshot)
      result = {
        context: { slot: 12345 },
        value: params[0].map((address: string) => pre.get(address) ?? null),
      };
    else if (body.method === "simulateTransaction") {
      const addresses: string[] = params[1].accounts.addresses;
      const accounts = addresses.map((address) => post.get(address) ?? null);
      if (truncatePost) accounts.pop();
      result = {
        context: { slot: simulationSlot },
        value: {
          err: simulationError,
          logs: ["program executed"],
          accounts: missingPost ? null : accounts,
        },
      };
    } else if (body.method === "getBalance")
      result = { context: { slot: 12345 }, value: 1_000_000_000 };
    else if (body.method === "getSlot") result = 12345;
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
function provider(chainEnvironment: SolanaConfig["chainEnvironment"]) {
  return new SolanaJsonRpcProvider({ rpcUrl, chainEnvironment, feePayer: payer.toBase58() });
}
function setupTokens(program = TOKEN) {
  const large = 9_007_199_254_740_993n;
  pre.set(source.toBase58(), tokenAccount(large, program));
  pre.set(destination.toBase58(), tokenAccount(0n, program));
  pre.set(mint.toBase58(), mintAccount(program));
  post.set(source.toBase58(), tokenAccount(large - 100n, program));
  post.set(destination.toBase58(), tokenAccount(100n, program));
  post.set(mint.toBase58(), mintAccount(program));
  post.set(payer.toBase58(), account(999_995_000));
}

describe("SolanaJsonRpcProvider balance evidence", () => {
  it("attests native movement including fees and observed unchanged balances", async () => {
    const result = await provider("devnet").simulateTransaction(parseInstructions([transfer]));
    expect(result.success && result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { account: payer.toBase58(), asset: "SOL", delta: "-5100" },
        { account: recipient.toBase58(), asset: "SOL", delta: "100" },
        { account: SYSTEM, asset: "SOL", delta: "0" },
      ]),
    );
  });
  it("attests native movement on mainnet only for mainnet-beta genesis", async () => {
    genesis = MAINNET_GENESIS;
    const result = await provider("mainnet").simulateTransaction(parseInstructions([transfer]));
    expect(result.success && result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { account: payer.toBase58(), asset: "SOL", delta: "-5100" },
        { account: recipient.toBase58(), asset: "SOL", delta: "100" },
        { account: SYSTEM, asset: "SOL", delta: "0" },
      ]),
    );
  });
  it.each([TOKEN, TOKEN_2022])("attests precise raw token balances for %s", async (program) => {
    setupTokens(program);
    const result = await provider("devnet").simulateTransaction(
      parseInstructions([tokenTransfer(program)]),
    );
    expect(result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { account: source.toBase58(), asset: mint.toBase58(), delta: "-100" },
        { account: destination.toBase58(), asset: mint.toBase58(), delta: "100" },
        { account: payer.toBase58(), asset: "SOL", delta: "-5000" },
      ]),
    );
  });
  it("accounts for created and closed token accounts instead of losing their balances", async () => {
    setupTokens();
    pre.set(destination.toBase58(), null);
    post.set(source.toBase58(), null);
    const result = await provider("devnet").simulateTransaction(
      parseInstructions([tokenTransfer()]),
    );
    expect(result.balanceChangesReliable).toBe(true);
    expect(result.balanceChanges).toEqual(
      expect.arrayContaining([
        { account: source.toBase58(), asset: mint.toBase58(), delta: "-9007199254740993" },
        { account: source.toBase58(), asset: "SOL", delta: "-2039280" },
        { account: destination.toBase58(), asset: mint.toBase58(), delta: "100" },
        { account: destination.toBase58(), asset: "SOL", delta: "2039280" },
      ]),
    );
  });
  it("refuses unrecognized token layouts rather than discarding their balances", async () => {
    setupTokens();
    const data = Buffer.alloc(355);
    Buffer.from(tokenAccount(100n).data[0], "base64").copy(data);
    data[2] = 1;
    post.set(destination.toBase58(), account(2_039_280, data, TOKEN));
    const result = await provider("devnet").simulateTransaction(
      parseInstructions([tokenTransfer()]),
    );
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it.each([
    "advanced-slot",
    "missing-accounts",
    "truncated-accounts",
    "unsafe-lamports",
    "bad-base64",
    "unsupported-rpc",
    "revert",
    "wrong-chain",
  ])("refuses unreliable %s evidence", async (mode) => {
    if (mode === "advanced-slot") simulationSlot++;
    if (mode === "missing-accounts") missingPost = true;
    if (mode === "truncated-accounts") truncatePost = true;
    if (mode === "unsafe-lamports")
      post.set(payer.toBase58(), account(Number.MAX_SAFE_INTEGER + 1));
    if (mode === "bad-base64")
      post.set(payer.toBase58(), { ...account(1), data: ["!invalid", "base64"] });
    if (mode === "unsupported-rpc") unsupportedSnapshot = true;
    if (mode === "revert") simulationError = { InstructionError: [0, "Custom"] };
    if (mode === "wrong-chain") genesis = MAINNET_GENESIS;
    const result = await provider("devnet").simulateTransaction(parseInstructions([transfer]));
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it.each([
    ["devnet", MAINNET_GENESIS],
    ["mainnet", DEVNET_GENESIS],
    ["devnet", "not-a-solana-genesis"],
    ["mainnet", "not-a-solana-genesis"],
  ] as const)("fails closed when %s config observes genesis %s", async (chainEnvironment, observedGenesis) => {
    genesis = observedGenesis;
    const result = await provider(chainEnvironment).simulateTransaction(
      parseInstructions([transfer]),
    );
    expect(result.success).toBe(false);
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it.each([
    "account",
    "mint",
  ])("rejects confidential Token-2022 %s state added in the simulation", async (target) => {
    setupTokens(TOKEN_2022);
    const data = Buffer.alloc(171);
    const original = target === "mint" ? mintAccount(TOKEN_2022) : tokenAccount(100n, TOKEN_2022);
    Buffer.from(original.data[0], "base64").copy(data);
    data[165] = target === "mint" ? 1 : 2;
    data.writeUInt16LE(target === "mint" ? 4 : 5, 166);
    data.writeUInt16LE(1, 168);
    post.set(
      (target === "mint" ? mint : destination).toBase58(),
      account(original.lamports, data, TOKEN_2022),
    );
    const result = await provider("devnet").simulateTransaction(
      parseInstructions([tokenTransfer(TOKEN_2022)]),
    );
    expect(result.balanceChangesReliable).toBe(false);
    expect(result.balanceChanges).toEqual([]);
  });
  it("returns balances and slots only for the configured cluster genesis", async () => {
    await expect(provider("devnet").getBalance(payer.toBase58())).resolves.toBe(1_000_000_000);
    await expect(provider("devnet").getSlot()).resolves.toBe(12345);
    genesis = MAINNET_GENESIS;
    await expect(provider("mainnet").getBalance(payer.toBase58())).resolves.toBe(1_000_000_000);
    await expect(provider("mainnet").getSlot()).resolves.toBe(12345);
    await expect(provider("devnet").getBalance(payer.toBase58())).rejects.toThrow();
    await expect(provider("devnet").getSlot()).rejects.toThrow();
    genesis = DEVNET_GENESIS;
    await expect(provider("mainnet").getBalance(payer.toBase58())).rejects.toThrow();
    await expect(provider("mainnet").getSlot()).rejects.toThrow();
    genesis = "not-a-solana-genesis";
    await expect(provider("devnet").getBalance(payer.toBase58())).rejects.toThrow();
    await expect(provider("mainnet").getSlot()).rejects.toThrow();
  });
  it("rejects unsupported chain environments before contacting RPC", () => {
    expect(
      () =>
        new SolanaJsonRpcProvider({
          rpcUrl,
          chainEnvironment: "mainnet-beta" as never,
          feePayer: payer.toBase58(),
        }),
    ).toThrow("Unsupported Solana chain environment mainnet-beta.");
  });
});

describe("built-in Solana provider signing boundary", () => {
  function signing(chainEnvironment: SolanaConfig["chainEnvironment"]) {
    const signAndBroadcast = vi.fn(async () => "accepted-by-signer");
    const connector = new SolanaConnector(
      {
        rpcUrl,
        chainEnvironment,
        allowedPrograms: [SYSTEM],
        allowedTokenMints: [],
        allowedAccounts: [payer.toBase58(), recipient.toBase58()],
      },
      provider(chainEnvironment),
      { getPublicKey: () => payer.toBase58(), signAndBroadcast },
    );
    const intent: Extract<OnchainSigningIntent, { chain: "solana" }> = {
      ...solanaDevnetSigning,
      chain: "solana",
      chainEnvironment,
      environment: chainEnvironment === "mainnet" ? "production" : "testnet",
      resource: `onchain:solana:${chainEnvironment}:${SYSTEM}`,
      to: SYSTEM,
      programId: SYSTEM,
      instructions: [transfer],
      expectedDeltas: [
        { account: payer.toBase58(), asset: "SOL", minDelta: "-5100", maxDelta: "-5100" },
        { account: recipient.toBase58(), asset: "SOL", minDelta: "100", maxDelta: "100" },
      ],
    };
    return { connector, signAndBroadcast, intent };
  }
  it("reaches signing only for reliable deltas bound to the actual fee payer", async () => {
    const { connector, intent, signAndBroadcast } = signing("devnet");
    await expect(connector.execute(intent)).resolves.toEqual({
      transactionHash: "accepted-by-signer",
    });
    expect(signAndBroadcast).toHaveBeenCalledOnce();
  });
  it("reaches signing on the production mainnet fixture when RPC reports mainnet-beta genesis", async () => {
    genesis = MAINNET_GENESIS;
    const { connector, intent, signAndBroadcast } = signing("mainnet");
    expect(intent.environment).toBe("production");
    expect(intent.resource).toBe(`onchain:solana:mainnet:${SYSTEM}`);
    await expect(connector.execute(intent)).resolves.toEqual({
      transactionHash: "accepted-by-signer",
    });
    expect(signAndBroadcast).toHaveBeenCalledOnce();
  });
  it.each([
    "delta-mismatch",
    "unreliable",
    "unexpected-program-balance",
  ])("never signs %s", async (mode) => {
    if (mode === "delta-mismatch") post.set(recipient.toBase58(), account(1099));
    if (mode === "unreliable") simulationSlot++;
    if (mode === "unexpected-program-balance")
      post.set(SYSTEM, { ...account(2), executable: true });
    const { connector, intent, signAndBroadcast } = signing("devnet");
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });
  it.each([
    ["devnet", MAINNET_GENESIS],
    ["mainnet", DEVNET_GENESIS],
    ["mainnet", "not-a-solana-genesis"],
  ] as const)("never signs %s config against genesis %s", async (chainEnvironment, observedGenesis) => {
    genesis = observedGenesis;
    const { connector, intent, signAndBroadcast } = signing(chainEnvironment);
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });
  it("rejects a simulation payer different from the signer", async () => {
    const result = await provider("devnet").simulateTransaction(parseInstructions([transfer]), {
      feePayer: recipient.toBase58(),
    });
    expect(result.success).toBe(false);
    expect(result.balanceChangesReliable).toBe(false);
  });
});
