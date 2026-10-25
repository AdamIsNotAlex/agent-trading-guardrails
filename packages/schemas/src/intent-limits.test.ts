import { describe, expect, it } from "vitest";
import {
  binanceSpotOrder,
  ethereumSepoliaSigning,
  ethereumSepoliaSimulation,
  solanaDevnetSigning,
  solanaDevnetSimulation,
} from "./fixtures.js";
import {
  CexOrderIntent,
  OnchainSigningIntent,
  OnchainSimulationIntent,
  TradingIntent,
} from "./intent.js";

const onchainCases = [
  {
    name: "Ethereum simulation",
    schema: OnchainSimulationIntent,
    intent: ethereumSepoliaSimulation,
  },
  { name: "Solana simulation", schema: OnchainSimulationIntent, intent: solanaDevnetSimulation },
  { name: "Ethereum signing", schema: OnchainSigningIntent, intent: ethereumSepoliaSigning },
  { name: "Solana signing", schema: OnchainSigningIntent, intent: solanaDevnetSigning },
];

describe("intent validation resource bounds", () => {
  it("accepts 64 evidence references and rejects the 65th", () => {
    const atLimit = { ...binanceSpotOrder, evidence: Array(64).fill("snapshot") };
    const overLimit = { ...atLimit, evidence: [...atLimit.evidence, "extra"] };
    for (const schema of [CexOrderIntent, TradingIntent]) {
      expect(schema.parse(atLimit)).toEqual(atLimit);
      const result = schema.safeParse(overLimit);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toMatchObject([
        { code: "too_big", path: ["evidence"], maximum: 64 },
      ]);
    }
  });

  it.each(onchainCases)("bounds instructions and balance deltas for $name", ({
    schema,
    intent,
  }) => {
    const delta = {
      ...(intent.chain === "ethereum" ? { address: "recipient" } : { account: "recipient" }),
      asset: "USDC",
      minDelta: "0",
      maxDelta: "1",
    };
    const atLimit = {
      ...intent,
      instructions: Array(64).fill({ type: "transfer" }),
      expectedDeltas: Array(256).fill(delta),
    };
    for (const validator of [schema, TradingIntent]) {
      expect(validator.parse(atLimit)).toEqual(atLimit);
      for (const field of ["instructions", "expectedDeltas"] as const) {
        const result = validator.safeParse({
          ...atLimit,
          [field]: [...atLimit[field], atLimit[field][0]],
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toMatchObject([
          { code: "too_big", path: [field], maximum: field === "instructions" ? 64 : 256 },
        ]);
      }
    }
  });

  it("rejects a roughly 50 KB malformed evidence array with one issue", () => {
    const input = { ...binanceSpotOrder, evidence: Array(10_000).fill(null) };
    const result = TradingIntent.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { code: "too_big", path: ["evidence"], maximum: 64 },
    ]);
  });

  it("rejects oversized collections before reading their elements", () => {
    const oversized = Array(10_000).fill(null);
    Object.defineProperty(oversized, "0", {
      get() {
        throw new Error("Oversized array elements must not be visited");
      },
    });
    const result = TradingIntent.safeParse({
      ...solanaDevnetSigning,
      evidence: oversized,
      instructions: oversized,
      expectedDeltas: oversized,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { code: "too_big", path: ["evidence"] },
      { code: "too_big", path: ["instructions"] },
      { code: "too_big", path: ["expectedDeltas"] },
    ]);
  });

  it("validates malformed elements only in the selected action and chain", () => {
    const result = TradingIntent.safeParse({
      ...solanaDevnetSigning,
      evidence: [null],
      expectedDeltas: [{ address: "evm-only", asset: "USDC", minDelta: "0", maxDelta: "1" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { code: "invalid_type", path: ["evidence", 0] },
      { code: "invalid_type", path: ["expectedDeltas", 0, "account"] },
      { code: "unrecognized_keys", path: ["expectedDeltas", 0] },
    ]);
  });

  it.each([
    { field: "action", input: { ...binanceSpotOrder, action: "cex.withdraw" } },
    { field: "chain", input: { ...solanaDevnetSigning, chain: "unknown" } },
  ])("rejects an unsupported $field without validating collection elements", ({ field, input }) => {
    const result = TradingIntent.safeParse({ ...input, evidence: Array(64).fill(null) });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([{ path: [field] }]);
  });
});
