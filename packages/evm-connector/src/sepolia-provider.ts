import { type Address, createPublicClient, type Hex, http, toHex } from "viem";
import { sepolia } from "viem/chains";
import type {
  EvmConfig,
  EvmRpcProvider,
  SimulateTransactionRequest,
  SimulationResult,
} from "./interfaces.js";
import {
  classifyAndExtract,
  erc20BalanceSlot,
  isPrestateDiff,
  normalizeAddress,
  parseQuantity,
} from "./trace-balances.js";

export type SepoliaRpcProviderConfig = Pick<EvmConfig, "rpcUrl"> &
  Partial<
    Pick<
      EvmConfig,
      "fromAddress" | "observedAccounts" | "allowedRecipients" | "allowedSpenders" | "erc20Tokens"
    >
  >;

export class SepoliaRpcProvider implements EvmRpcProvider {
  private client;

  constructor(private config: SepoliaRpcProviderConfig) {
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  }

  async simulateTransaction(tx: SimulateTransactionRequest): Promise<SimulationResult> {
    try {
      const from = address(tx.from ?? this.config.fromAddress ?? "");
      const to = address(tx.to);
      const observed = [
        ...new Set(
          [
            from,
            to,
            ...(tx.observedAddresses ?? []),
            ...(this.config.observedAccounts ?? []),
            ...(this.config.allowedRecipients ?? []),
            ...(this.config.allowedSpenders ?? []),
          ].map(address),
        ),
      ];
      const tokens = this.config.erc20Tokens ?? [];
      await this.assertSepoliaChain();
      const block = pinnedBlock(await this.rpc("eth_getBlockByNumber", ["latest", false]));
      // Effect deltas exclude execution fees; the signing backend must independently cap fees.
      const call = {
        from,
        to,
        data: tx.data ?? "0x",
        value: toHex(BigInt(tx.value ?? "0")),
        gasPrice: "0x0",
      };
      const execution = object(
        await this.rpc("debug_traceCall", [
          call,
          block.number,
          {
            tracer: "callTracer",
            tracerConfig: { onlyTopCall: true },
          },
        ]),
      );
      if (execution.error !== undefined)
        throw new Error(`Execution reverted: ${String(execution.error)}`);
      if (address(String(execution.from)) !== from || address(String(execution.to)) !== to) {
        throw new Error("Execution trace does not match the simulation sender and destination.");
      }
      const gasUsed = quantity(execution.gasUsed);
      if (gasUsed === 0n || gasUsed > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Invalid traced gas usage.");
      const trace = await this.rpc("debug_traceCall", [
        call,
        block.number,
        {
          tracer: "prestateTracer",
          tracerConfig: { diffMode: true },
        },
      ]);
      if (!isPrestateDiff(trace))
        throw new Error("RPC did not return a prestateTracer state diff.");
      const pre = normalizeAccounts(trace.pre);
      const post = normalizeAccounts(trace.post);
      if (!Object.hasOwn(pre, from) && !Object.hasOwn(post, from)) {
        throw new Error("Execution state diff is empty or missing the sender.");
      }
      const extracted = classifyAndExtract({ pre, post, tokens, observedAddresses: observed });
      if (!extracted.ok) throw new Error(extracted.reason);
      for (const probe of extracted.nativeProbes) {
        const balance = quantity(await this.rpc("eth_getBalance", [probe.address, block.number]));
        if (balance !== probe.preBalance)
          throw new Error("Native pre-state disagrees with the pinned block.");
      }
      const overrides = stateOverrides(pre, post);
      const changes = extracted.changes;
      // Include observed zero effects: an explicit unchanged-balance expectation needs evidence too.
      for (const account of observed) {
        if (!changes.some((change) => change.address === account && change.asset === "ETH")) {
          await this.rpc("eth_getBalance", [account, block.number]).then(quantity);
          changes.push({ address: account, asset: "ETH", delta: "0" });
        }
      }
      for (const token of tokens) {
        const tokenAddress = address(token.address);
        for (const account of observed) {
          const data = `0x70a08231${account.slice(2).padStart(64, "0")}`;
          const probe = { from, to: tokenAddress, data, gasPrice: "0x0" };
          const before = tokenAmount(await this.rpc("eth_call", [probe, block.number]));
          const slot = erc20BalanceSlot(account, quantity(token.balanceSlot));
          const stored = tokenAmount(
            await this.rpc("eth_getStorageAt", [tokenAddress, slot, block.number]),
          );
          if (before !== stored)
            throw new Error("Configured ERC-20 layout does not match balanceOf.");
          const traced = extracted.probes.find(
            (entry) => entry.token === tokenAddress && entry.account === account,
          );
          if (traced && traced.preBalance !== before)
            throw new Error("Token pre-state disagrees with balanceOf.");
          const after = tokenAmount(await this.rpc("eth_call", [probe, block.number, overrides]));
          const change = changes.find(
            (entry) => entry.address === account && entry.asset === token.asset,
          );
          const delta = after - before;
          if (delta !== BigInt(change?.delta ?? "0")) {
            throw new Error("Token post-state disagrees with the configured balance mapping.");
          }
          if (!change) changes.push({ address: account, asset: token.asset, delta: "0" });
        }
      }
      const current = pinnedBlock(await this.rpc("eth_getBlockByNumber", [block.number, false]));
      if (current.hash !== block.hash || current.number !== block.number) {
        throw new Error("Simulation block changed during balance observation.");
      }
      return {
        success: true,
        gasUsed: Number(gasUsed),
        balanceChanges: changes,
        balanceChangesReliable: true,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        gasUsed: 0,
        balanceChanges: [],
        balanceChangesReliable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getBalance(account: string): Promise<string> {
    await this.assertSepoliaChain();
    return (await this.client.getBalance({ address: account as Address })).toString();
  }

  async getBlockNumber(): Promise<number> {
    await this.assertSepoliaChain();
    return Number(await this.client.getBlockNumber());
  }

  private async assertSepoliaChain(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== sepolia.id)
      throw new Error(
        `Configured EVM RPC returned chain ID ${chainId}; expected Sepolia ${sepolia.id}.`,
      );
  }

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    // viem's default schema omits Geth debug methods; validate their responses at this boundary.
    return this.client.request({ method, params } as never);
  }
}

function address(value: string): string {
  const normalized = normalizeAddress(value);
  if (!normalized) throw new Error(`Invalid Ethereum address ${value}.`);
  return normalized;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed RPC object.");
  return value as Record<string, unknown>;
}

function quantity(value: unknown): bigint {
  const parsed = parseQuantity(value);
  if (parsed === null || parsed >= 1n << 256n) throw new Error("Malformed RPC integer quantity.");
  return parsed;
}

function tokenAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Malformed ERC-20 balance word.");
  return BigInt(value);
}

function pinnedBlock(value: unknown): { number: Hex; hash: string } {
  const block = object(value);
  if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash))
    throw new Error("Missing simulation block hash.");
  return { number: toHex(quantity(block.number)), hash: block.hash.toLowerCase() };
}

function normalizeAccounts(accounts: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(accounts)) {
    const account = address(key);
    if (Object.hasOwn(normalized, account)) throw new Error("Duplicate trace account.");
    normalized[account] = object(value);
  }
  return normalized;
}

function stateOverrides(
  pre: Record<string, unknown>,
  post: Record<string, unknown>,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const account of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    const before = pre[account] === undefined ? {} : object(pre[account]);
    const after = post[account] === undefined ? {} : object(post[account]);
    const override: Record<string, unknown> = {};
    if (post[account] === undefined) override.balance = "0x0";
    else if (after.balance !== undefined) override.balance = toHex(quantity(after.balance));
    const beforeStorage = before.storage === undefined ? {} : object(before.storage);
    const afterStorage = after.storage === undefined ? {} : object(after.storage);
    const stateDiff: Record<string, string> = {};
    for (const slot of new Set([...Object.keys(beforeStorage), ...Object.keys(afterStorage)])) {
      stateDiff[toHex(BigInt(slot), { size: 32 })] = toHex(quantity(afterStorage[slot] ?? "0x0"), {
        size: 32,
      });
    }
    if (Object.keys(stateDiff).length) override.stateDiff = stateDiff;
    if (Object.keys(override).length) overrides[account] = override;
  }
  return overrides;
}
