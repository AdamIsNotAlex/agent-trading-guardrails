import { PublicKey } from "@solana/web3.js";
import type { SolanaSimulationResult } from "./interfaces.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const NATIVE_SOL_ASSET = "SOL";
export const MAX_OBSERVATION_ACCOUNTS = 100;

interface AccountSnapshot {
  lamports: bigint;
  owner: string;
  data: Buffer;
  executable: boolean;
}

export type ResolvedSnapshot = AccountSnapshot | null;
type TokenBalance = { mint: string; amount: bigint } | null;

// Only extensions whose public raw amount remains observable are supported.
const ACCOUNT_EXTENSIONS = new Set([2, 7, 8, 11, 13, 15, 27]);
const MINT_EXTENSIONS = new Set([1, 3, 6, 9, 10, 12, 14, 18, 19, 20, 21, 22, 23, 25, 26]);

export function pubkeyOf(value: unknown): string | null {
  try {
    if (typeof value === "string") return new PublicKey(value).toBase58();
    if (value instanceof PublicKey) return value.toBase58();
  } catch {
    return null;
  }
  return null;
}

function snapshot(account: unknown, encoded: boolean): ResolvedSnapshot {
  if (account === null) return null;
  if (!account || typeof account !== "object") throw new Error("Missing account snapshot.");
  const fields = account as Record<string, unknown>;
  if (
    typeof fields.lamports !== "number" ||
    !Number.isSafeInteger(fields.lamports) ||
    fields.lamports < 0
  ) {
    throw new Error("Account lamports must be a nonnegative safe integer.");
  }
  const owner = pubkeyOf(fields.owner);
  if (!owner || typeof fields.executable !== "boolean") {
    throw new Error("Account owner or executable flag is invalid.");
  }
  let data: Buffer;
  if (encoded) {
    const tuple = fields.data;
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== "string" ||
      tuple[1] !== "base64"
    ) {
      throw new Error("Account data must be a base64 tuple.");
    }
    data = Buffer.from(tuple[0], "base64");
    if (data.toString("base64") !== tuple[0]) throw new Error("Account data is not valid base64.");
  } else {
    if (!Buffer.isBuffer(fields.data)) throw new Error("Account data is not a Buffer.");
    data = fields.data;
  }
  return { lamports: BigInt(fields.lamports), owner, data, executable: fields.executable };
}

export function snapshotFromPre(account: unknown): ResolvedSnapshot {
  return snapshot(account, false);
}

export function snapshotFromPost(account: unknown): ResolvedSnapshot {
  return snapshot(account, true);
}

function inspectExtensions(data: Buffer, accountType: number, allowed: Set<number>): void {
  if (data.length < 166 || data[165] !== accountType) {
    throw new Error("Token-2022 account type or extension layout is invalid.");
  }
  let offset = 166;
  const seen = new Set<number>();
  while (offset < data.length) {
    if (data.subarray(offset).every((byte) => byte === 0)) return;
    if (offset + 4 > data.length) throw new Error("Token-2022 extensions are truncated.");
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (!allowed.has(type) || seen.has(type)) {
      throw new Error(`Unsupported or confidential Token-2022 extension ${type}.`);
    }
    if (offset + 4 + length > data.length) throw new Error("Token-2022 extensions are truncated.");
    seen.add(type);
    offset += 4 + length;
  }
}

function validateMint(snapshot: AccountSnapshot, token2022: boolean): void {
  if (snapshot.data.length < 82 || snapshot.data[45] !== 1) {
    throw new Error("Token mint is truncated or uninitialized.");
  }
  if (snapshot.data.length !== 82) {
    if (!token2022) throw new Error("Classic token mint has an invalid length.");
    inspectExtensions(snapshot.data, 1, MINT_EXTENSIONS);
  }
}

function decodeToken(
  snapshot: ResolvedSnapshot,
  snapshots: Map<string, ResolvedSnapshot>,
): TokenBalance {
  if (!snapshot || snapshot.executable) return null;
  const token2022 = snapshot.owner === TOKEN_2022_PROGRAM_ID;
  if (!token2022 && snapshot.owner !== TOKEN_PROGRAM_ID) return null;
  const data = snapshot.data;
  if (data.length === 82 || (token2022 && data.length > 165 && data[165] === 1)) {
    validateMint(snapshot, token2022);
    return null;
  }
  if (data.length < 165 || (!token2022 && data.length !== 165)) {
    throw new Error("Token account has an invalid length.");
  }
  if (token2022 && data.length !== 165) inspectExtensions(data, 2, ACCOUNT_EXTENSIONS);
  const amount = data.readBigUInt64LE(64);
  if (data[108] === 0 && amount === 0n) return null;
  if (data[108] !== 1 && data[108] !== 2) throw new Error("Token account state is invalid.");
  const mint = new PublicKey(data.subarray(0, 32)).toBase58();
  if (token2022) {
    const mintSnapshot = snapshots.get(mint);
    if (!mintSnapshot || mintSnapshot.owner !== TOKEN_2022_PROGRAM_ID) {
      throw new Error(`Token-2022 mint ${mint} is missing from the observation set.`);
    }
    validateMint(mintSnapshot, true);
  }
  return { mint, amount };
}

export function diffObservedBalances(
  addresses: string[],
  pre: Map<string, ResolvedSnapshot>,
  post: Map<string, ResolvedSnapshot>,
): SolanaSimulationResult["balanceChanges"] {
  const changes: SolanaSimulationResult["balanceChanges"] = [];
  for (const address of addresses) {
    if (!pre.has(address) || !post.has(address)) throw new Error("Missing account snapshot.");
    const before = pre.get(address) ?? null;
    const after = post.get(address) ?? null;
    changes.push({
      account: address,
      asset: NATIVE_SOL_ASSET,
      delta: ((after?.lamports ?? 0n) - (before?.lamports ?? 0n)).toString(),
    });
    const beforeToken = decodeToken(before, pre);
    const afterToken = decodeToken(after, post);
    if (beforeToken && afterToken && beforeToken.mint !== afterToken.mint) {
      throw new Error("Token account mint changed during simulation.");
    }
    const mint = afterToken?.mint ?? beforeToken?.mint;
    if (mint) {
      changes.push({
        account: address,
        asset: mint,
        delta: ((afterToken?.amount ?? 0n) - (beforeToken?.amount ?? 0n)).toString(),
      });
    }
  }
  return changes;
}
