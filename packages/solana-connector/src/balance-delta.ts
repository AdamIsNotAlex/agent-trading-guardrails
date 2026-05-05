import type { SolanaSimulationResult } from "./interfaces.js";

export interface ExpectedSolanaBalanceDelta {
  account: string;
  asset: string;
  minDelta: string;
  maxDelta: string;
}

export interface BalanceDeltaMismatch {
  account: string;
  asset: string;
  reason: string;
}

export interface BalanceDeltaComparison {
  passed: boolean;
  reasons: BalanceDeltaMismatch[];
}

export function compareSolanaBalanceDeltas(
  balanceChanges: SolanaSimulationResult["balanceChanges"],
  expectedDeltas: ExpectedSolanaBalanceDelta[],
): BalanceDeltaComparison {
  const reasons: BalanceDeltaMismatch[] = [];

  for (const change of balanceChanges) {
    if (!isSolanaBalanceChange(change)) {
      reasons.push({
        account: "",
        asset: "",
        reason: "Simulation balance change entries must use account-based integer entries.",
      });
      continue;
    }
    const expected = expectedDeltas.find(
      (delta) => delta.account === change.account && delta.asset === change.asset,
    );
    const delta = parseDelta(change.delta);
    if (!expected && (delta === null || delta !== 0n)) {
      reasons.push({
        account: change.account,
        asset: change.asset,
        reason: "Simulation included an unexpected balance change.",
      });
    }
  }

  for (const expected of expectedDeltas) {
    const matchingChanges = balanceChanges.filter(
      (change) =>
        isSolanaBalanceChange(change) &&
        change.account === expected.account &&
        change.asset === expected.asset,
    );

    if (matchingChanges.length === 0) {
      reasons.push({
        account: expected.account,
        asset: expected.asset,
        reason: "Expected balance change was not present in simulation result.",
      });
      continue;
    }

    const actualDeltas = matchingChanges.map((change) => parseDelta(change.delta));
    const minDelta = parseDelta(expected.minDelta);
    const maxDelta = parseDelta(expected.maxDelta);
    if (actualDeltas.some((delta) => delta === null) || minDelta === null || maxDelta === null) {
      reasons.push({
        account: expected.account,
        asset: expected.asset,
        reason: "Balance delta values must be integer strings.",
      });
      continue;
    }

    const actualDelta = actualDeltas.reduce<bigint>((total, delta) => total + (delta ?? 0n), 0n);
    if (actualDelta < minDelta || actualDelta > maxDelta) {
      reasons.push({
        account: expected.account,
        asset: expected.asset,
        reason: `Delta ${actualDelta.toString()} is outside expected range ${expected.minDelta}..${expected.maxDelta}.`,
      });
    }
  }

  return { passed: reasons.length === 0, reasons };
}

function isSolanaBalanceChange(
  change: unknown,
): change is SolanaSimulationResult["balanceChanges"][number] {
  if (!change || typeof change !== "object") return false;
  const fields = change as Record<string, unknown>;
  return (
    typeof fields.account === "string" &&
    fields.account.length > 0 &&
    typeof fields.asset === "string" &&
    fields.asset.length > 0
  );
}

function parseDelta(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}
