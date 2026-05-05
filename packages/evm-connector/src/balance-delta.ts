import type { SimulationResult } from "./interfaces.js";

export interface ExpectedEvmBalanceDelta {
  address: string;
  asset: string;
  minDelta: string;
  maxDelta: string;
}

export interface BalanceDeltaMismatch {
  address: string;
  asset: string;
  reason: string;
}

export interface BalanceDeltaComparison {
  passed: boolean;
  reasons: BalanceDeltaMismatch[];
}

export function compareEvmBalanceDeltas(
  balanceChanges: SimulationResult["balanceChanges"],
  expectedDeltas: ExpectedEvmBalanceDelta[],
): BalanceDeltaComparison {
  const reasons: BalanceDeltaMismatch[] = [];

  for (const change of balanceChanges) {
    if (!isEvmBalanceChange(change)) {
      reasons.push({
        address: "",
        asset: "",
        reason: "Simulation balance change entries must use address-based integer entries.",
      });
      continue;
    }
    const expected = expectedDeltas.find(
      (delta) =>
        delta.address.toLowerCase() === change.address.toLowerCase() &&
        delta.asset.toLowerCase() === change.asset.toLowerCase(),
    );
    const delta = parseDelta(change.delta);
    if (!expected && (delta === null || delta !== 0n)) {
      reasons.push({
        address: change.address,
        asset: change.asset,
        reason: "Simulation included an unexpected balance change.",
      });
    }
  }

  for (const expected of expectedDeltas) {
    const matchingChanges = balanceChanges.filter(
      (change) =>
        isEvmBalanceChange(change) &&
        change.address.toLowerCase() === expected.address.toLowerCase() &&
        change.asset.toLowerCase() === expected.asset.toLowerCase(),
    );

    if (matchingChanges.length === 0) {
      reasons.push({
        address: expected.address,
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
        address: expected.address,
        asset: expected.asset,
        reason: "Balance delta values must be integer strings.",
      });
      continue;
    }

    const actualDelta = actualDeltas.reduce<bigint>((total, delta) => total + (delta ?? 0n), 0n);
    if (actualDelta < minDelta || actualDelta > maxDelta) {
      reasons.push({
        address: expected.address,
        asset: expected.asset,
        reason: `Delta ${actualDelta.toString()} is outside expected range ${expected.minDelta}..${expected.maxDelta}.`,
      });
    }
  }

  return { passed: reasons.length === 0, reasons };
}

function isEvmBalanceChange(change: unknown): change is SimulationResult["balanceChanges"][number] {
  if (!change || typeof change !== "object") return false;
  const fields = change as Record<string, unknown>;
  return (
    typeof fields.address === "string" &&
    fields.address.length > 0 &&
    typeof fields.asset === "string" &&
    fields.asset.length > 0
  );
}

function parseDelta(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}
