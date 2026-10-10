import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddress,
  keccak256,
} from "viem";
import type { EvmErc20TokenConfig, SimulationResult } from "./interfaces.js";

const NATIVE_ASSET = "ETH";

export type BalanceChange = SimulationResult["balanceChanges"][number];

export type TokenBalanceProbe = {
  token: string;
  account: string;
  preBalance: bigint;
};

export type NativeBalanceProbe = {
  address: string;
  preBalance: bigint;
};

export type ExtractionResult =
  | {
      ok: true;
      changes: BalanceChange[];
      probes: TokenBalanceProbe[];
      nativeProbes: NativeBalanceProbe[];
    }
  | { ok: false; reason: string };

type ClassifiedSlot =
  | { kind: "balance"; asset: string; account: string }
  | { kind: "allowance" }
  | { kind: "supply" };

type AccountSnapshot = {
  balance?: unknown;
  nonce?: unknown;
  code?: unknown;
  storage?: unknown;
};

export function erc20BalanceSlot(account: string, slot: bigint): Hex {
  return mappingSlot(getAddress(account), slot);
}

export function erc20AllowanceSlot(owner: string, spender: string, slot: bigint): Hex {
  const inner = mappingSlot(getAddress(owner), slot);
  return mappingSlot(getAddress(spender), BigInt(inner));
}

export function classifyAndExtract(args: {
  pre: unknown;
  post: unknown;
  tokens: EvmErc20TokenConfig[];
  observedAddresses: string[];
}): ExtractionResult {
  if (!isAccountMap(args.pre) || !isAccountMap(args.post)) {
    return {
      ok: false,
      reason: "debug_traceCall prestateTracer diff is missing pre/post account maps.",
    };
  }

  const observed = new Set<string>();
  for (const address of args.observedAddresses) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      return { ok: false, reason: `Observed address ${address} is not a valid Ethereum address.` };
    }
    observed.add(normalized);
  }

  let slotIndex: Map<string, Map<string, ClassifiedSlot>>;
  try {
    slotIndex = buildSlotIndex(args.tokens, [...observed]);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "ERC-20 mapping slots are invalid.",
    };
  }

  const tokenByAddress = new Map<string, EvmErc20TokenConfig>();
  for (const token of args.tokens) {
    const address = normalizeAddress(token.address);
    if (!address) {
      return {
        ok: false,
        reason: `ERC-20 token address ${token.address} is not a valid Ethereum address.`,
      };
    }
    if (!token.asset) {
      return { ok: false, reason: "ERC-20 token asset identifiers are required." };
    }
    if (token.balanceSlot === undefined || token.balanceSlot === null || token.balanceSlot === "") {
      return {
        ok: false,
        reason: `ERC-20 token ${token.address} is missing required balanceSlot.`,
      };
    }
    tokenByAddress.set(address, token);
  }

  const ethDeltas = new Map<string, bigint>();
  const tokenDeltas = new Map<string, bigint>();
  const probes: TokenBalanceProbe[] = [];
  const nativeProbes: NativeBalanceProbe[] = [];
  const probed = new Set<string>();
  const nativeProbed = new Set<string>();
  const addresses = new Set([...Object.keys(args.pre), ...Object.keys(args.post)]);

  for (const rawAddress of addresses) {
    const address = normalizeAddress(rawAddress);
    if (!address) {
      return { ok: false, reason: `Trace account ${rawAddress} is not a valid Ethereum address.` };
    }

    const preAccount = asAccount(args.pre[rawAddress]);
    const postAccount = asAccount(args.post[rawAddress]);
    if (args.pre[rawAddress] !== undefined && !preAccount) {
      return { ok: false, reason: `Trace pre-state for ${address} is malformed.` };
    }
    if (args.post[rawAddress] !== undefined && !postAccount) {
      return { ok: false, reason: `Trace post-state for ${address} is malformed.` };
    }

    const created = !preAccount && Boolean(postAccount);
    const destroyed = Boolean(preAccount) && !postAccount;
    const native = nativeDelta(preAccount, postAccount, created, destroyed);
    if (!native.ok) {
      return { ok: false, reason: native.reason.replaceAll("$address", address) };
    }
    ethDeltas.set(address, (ethDeltas.get(address) ?? 0n) + native.delta);
    if (!nativeProbed.has(address)) {
      nativeProbed.add(address);
      nativeProbes.push({ address, preBalance: native.preBalance });
    }

    const code = codeDelta(preAccount, postAccount, created, destroyed);
    if (!code.ok) {
      return { ok: false, reason: code.reason.replaceAll("$address", address) };
    }

    const storageDiff = diffStorage(preAccount?.storage, postAccount?.storage, destroyed);
    if (!storageDiff.ok) {
      return storageDiff;
    }

    const classifiedSlots = tokenByAddress.has(address) ? slotIndex.get(address) : undefined;
    for (const change of storageDiff.changes) {
      if (change.delta === 0n) continue;
      const classified = classifiedSlots?.get(change.slot);
      if (!classified) {
        return {
          ok: false,
          reason: `Unclassified storage slot ${change.slot} changed on ${address}.`,
        };
      }
      if (classified.kind !== "balance") {
        continue;
      }
      if (!observed.has(classified.account)) {
        return {
          ok: false,
          reason: `Token balance slot for unobserved account ${classified.account} changed.`,
        };
      }
      const mapKey = `${classified.account}:${classified.asset}`;
      tokenDeltas.set(mapKey, (tokenDeltas.get(mapKey) ?? 0n) + change.delta);
      const probeKey = `${address}:${classified.account}`;
      if (!probed.has(probeKey)) {
        probed.add(probeKey);
        probes.push({
          token: address,
          account: classified.account,
          preBalance: change.pre,
        });
      }
    }
  }

  const changes: BalanceChange[] = [];
  for (const [address, delta] of ethDeltas) {
    changes.push({ address, asset: NATIVE_ASSET, delta: delta.toString() });
  }
  for (const [mapKey, delta] of tokenDeltas) {
    if (delta === 0n) continue;
    const split = mapKey.indexOf(":");
    changes.push({
      address: mapKey.slice(0, split),
      asset: mapKey.slice(split + 1),
      delta: delta.toString(),
    });
  }
  changes.sort((left, right) => {
    const addressOrder = left.address.localeCompare(right.address);
    return addressOrder !== 0 ? addressOrder : left.asset.localeCompare(right.asset);
  });
  return { ok: true, changes, probes, nativeProbes };
}

export function parseQuantity(value: unknown): bigint | null {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value === "string" && !/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string")
    return null;
  const parsed = BigInt(value);
  return parsed >= 0n && parsed < 1n << 256n ? parsed : null;
}

export function isPrestateDiff(
  value: unknown,
): value is { pre: Record<string, unknown>; post: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("structLogs" in record) return false;
  return isAccountMap(record.pre) && isAccountMap(record.post);
}

export function normalizeAddress(value: string): string | null {
  if (!isAddress(value, { strict: false })) return null;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

function buildSlotIndex(
  tokens: EvmErc20TokenConfig[],
  observed: string[],
): Map<string, Map<string, ClassifiedSlot>> {
  const index = new Map<string, Map<string, ClassifiedSlot>>();
  const assets = new Set<string>([NATIVE_ASSET.toLowerCase()]);
  for (const token of tokens) {
    const tokenAddress = normalizeAddress(token.address);
    if (!tokenAddress) {
      throw new Error(`ERC-20 token address ${token.address} is not a valid Ethereum address.`);
    }
    if (index.has(tokenAddress) || !token.asset || assets.has(token.asset.toLowerCase())) {
      throw new Error("ERC-20 token addresses and asset identifiers must be unique.");
    }
    assets.add(token.asset.toLowerCase());
    if (token.balanceSlot === undefined || token.balanceSlot === null || token.balanceSlot === "") {
      throw new Error(`ERC-20 token ${token.address} is missing required balanceSlot.`);
    }
    const balanceSlot = parseSlotIndex(token.balanceSlot);
    const slots = index.get(tokenAddress) ?? new Map<string, ClassifiedSlot>();
    for (const account of observed) {
      slots.set(erc20BalanceSlot(account, balanceSlot), {
        kind: "balance",
        asset: token.asset,
        account,
      });
    }
    if (
      token.allowanceSlot !== undefined &&
      token.allowanceSlot !== null &&
      token.allowanceSlot !== ""
    ) {
      const allowanceSlot = parseSlotIndex(token.allowanceSlot);
      for (const owner of observed) {
        for (const spender of observed) {
          slots.set(erc20AllowanceSlot(owner, spender, allowanceSlot), { kind: "allowance" });
        }
      }
    }
    if (
      token.totalSupplySlot !== undefined &&
      token.totalSupplySlot !== null &&
      token.totalSupplySlot !== ""
    ) {
      const supplySlot = normalizeSlot(toHexQuantity(parseSlotIndex(token.totalSupplySlot)));
      if (!supplySlot) {
        throw new Error(`ERC-20 token ${token.address} has an invalid totalSupplySlot.`);
      }
      if (slots.has(supplySlot)) throw new Error("ERC-20 storage layout slots overlap.");
      slots.set(supplySlot, { kind: "supply" });
    }
    index.set(tokenAddress, slots);
  }
  return index;
}

function parseSlotIndex(value: bigint | number | string): bigint {
  const parsed = parseQuantity(value);
  if (parsed === null) throw new Error("ERC-20 mapping slot must be an exact uint256 integer.");
  return parsed;
}

function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "key", type: "address" },
        { name: "slot", type: "uint256" },
      ],
      [key, slot],
    ),
  );
}

function isAccountMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asAccount(value: unknown): AccountSnapshot | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AccountSnapshot;
}

function nativeDelta(
  preAccount: AccountSnapshot | null,
  postAccount: AccountSnapshot | null,
  created: boolean,
  destroyed: boolean,
): { ok: true; delta: bigint; preBalance: bigint } | { ok: false; reason: string } {
  if (created) {
    const post =
      postAccount && postAccount.balance !== undefined ? parseQuantity(postAccount.balance) : 0n;
    if (post === null) {
      return { ok: false, reason: "Native balance for $address is not an integer quantity." };
    }
    return { ok: true, delta: post, preBalance: 0n };
  }
  if (destroyed) {
    if (!preAccount || preAccount.balance === undefined) {
      return {
        ok: false,
        reason: "Native balance for $address is missing from the pre-state diff.",
      };
    }
    const pre = parseQuantity(preAccount.balance);
    if (pre === null) {
      return { ok: false, reason: "Native balance for $address is not an integer quantity." };
    }
    return { ok: true, delta: -pre, preBalance: pre };
  }
  if (!preAccount || preAccount.balance === undefined) {
    return {
      ok: false,
      reason: "Native balance for $address is missing from the pre-state diff.",
    };
  }
  const pre = parseQuantity(preAccount.balance);
  if (pre === null) {
    return { ok: false, reason: "Native balance for $address is not an integer quantity." };
  }
  if (!postAccount || postAccount.balance === undefined) {
    return { ok: true, delta: 0n, preBalance: pre };
  }
  const post = parseQuantity(postAccount.balance);
  if (post === null) {
    return { ok: false, reason: "Native balance for $address is not an integer quantity." };
  }
  return { ok: true, delta: post - pre, preBalance: pre };
}

function codeDelta(
  preAccount: AccountSnapshot | null,
  postAccount: AccountSnapshot | null,
  created: boolean,
  destroyed: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (parseCode(preAccount?.code) === null || parseCode(postAccount?.code) === null) {
    return { ok: false, reason: "Contract code for $address is malformed." };
  }
  if (created) {
    const post = parseCode(postAccount?.code);
    if (post === null) return { ok: false, reason: "Contract code for $address is malformed." };
    if (post !== "0x") {
      return { ok: false, reason: "Simulation created contract code for $address." };
    }
    return { ok: true };
  }
  if (destroyed) {
    const pre = parseCode(preAccount?.code);
    if (pre === null) return { ok: false, reason: "Contract code for $address is malformed." };
    if (pre !== "0x") {
      return { ok: false, reason: "Contract code changed for $address." };
    }
    return { ok: true };
  }
  if (!postAccount || postAccount.code === undefined) return { ok: true };
  if (!preAccount || preAccount.code === undefined) {
    return {
      ok: false,
      reason: "Contract code for $address is inconsistently present in the pre/post diff.",
    };
  }
  const pre = parseCode(preAccount.code);
  const post = parseCode(postAccount.code);
  if (pre === null || post === null) {
    return { ok: false, reason: "Contract code for $address is malformed." };
  }
  if (pre !== post) return { ok: false, reason: "Contract code changed for $address." };
  return { ok: true };
}

function parseCode(value: unknown): string | null {
  if (value === undefined) return "0x";
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return null;
  return value.toLowerCase();
}

function diffStorage(
  preStorage: unknown,
  postStorage: unknown,
  destroyed: boolean,
):
  | { ok: true; changes: Array<{ slot: string; pre: bigint; delta: bigint }> }
  | { ok: false; reason: string } {
  const pre = parseStorageMap(preStorage);
  if (!pre.ok) return pre;

  if (destroyed) {
    const changes: Array<{ slot: string; pre: bigint; delta: bigint }> = [];
    for (const [slot, before] of pre.map) {
      if (before === 0n) continue;
      changes.push({ slot, pre: before, delta: -before });
    }
    return { ok: true, changes };
  }

  const post = parseStorageMap(postStorage);
  if (!post.ok) return post;

  const changes: Array<{ slot: string; pre: bigint; delta: bigint }> = [];
  for (const [slot, after] of post.map) {
    const before = pre.map.get(slot) ?? 0n;
    if (before === after) continue;
    changes.push({ slot, pre: before, delta: after - before });
  }
  for (const [slot, before] of pre.map) {
    if (post.map.has(slot) || before === 0n) continue;
    changes.push({ slot, pre: before, delta: -before });
  }
  return { ok: true, changes };
}

function parseStorageMap(
  value: unknown,
): { ok: true; map: Map<string, bigint> } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, map: new Map() };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "Trace storage map is malformed." };
  }
  const map = new Map<string, bigint>();
  for (const [rawSlot, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const slot = normalizeSlot(rawSlot);
    const parsed = parseQuantity(rawValue);
    if (!slot || parsed === null || map.has(slot)) {
      return { ok: false, reason: `Trace storage slot ${rawSlot} is malformed.` };
    }
    map.set(slot, parsed);
  }
  return { ok: true, map };
}

function normalizeSlot(slot: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(slot)) return null;
  const hex = slot.slice(2).toLowerCase();
  if (hex.length > 64) return null;
  return `0x${hex.padStart(64, "0")}`;
}

function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}
