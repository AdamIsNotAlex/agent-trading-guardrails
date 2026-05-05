import { describe, expect, it } from "vitest";
import { compareEvmBalanceDeltas } from "./balance-delta.js";

const changes = [
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    asset: "USDC",
    delta: "-100",
  },
];

describe("compareEvmBalanceDeltas", () => {
  it("passes exact matches", () => {
    const result = compareEvmBalanceDeltas(changes, [
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        asset: "USDC",
        minDelta: "-100",
        maxDelta: "-100",
      },
    ]);

    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it("aggregates duplicate matching deltas", () => {
    const result = compareEvmBalanceDeltas(
      [
        { ...changes[0], delta: "-60" },
        { ...changes[0], delta: "-40" },
      ],
      [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-100",
          maxDelta: "-100",
        },
      ],
    );

    expect(result.passed).toBe(true);
  });

  it("passes deltas within tolerance", () => {
    const result = compareEvmBalanceDeltas(changes, [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        asset: "usdc",
        minDelta: "-101",
        maxDelta: "-99",
      },
    ]);

    expect(result.passed).toBe(true);
  });

  it("fails missing expected changes", () => {
    const result = compareEvmBalanceDeltas(
      [],
      [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "0",
          maxDelta: "0",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("not present");
  });

  it("fails malformed delta values", () => {
    const result = compareEvmBalanceDeltas(
      [{ ...changes[0], delta: 1 as never }],
      [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "0",
          maxDelta: "10",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("integer strings");
  });

  it("fails malformed expected ranges", () => {
    const result = compareEvmBalanceDeltas(changes, [
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        asset: "USDC",
        minDelta: "-1.5",
        maxDelta: "10",
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("integer strings");
  });

  it("fails out-of-range deltas", () => {
    const result = compareEvmBalanceDeltas(changes, [
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        asset: "USDC",
        minDelta: "-50",
        maxDelta: "0",
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatchObject({
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      asset: "USDC",
    });
    expect(result.reasons[0]?.reason).toContain("outside expected range");
  });

  it("fails unexpected nonzero balance changes", () => {
    const result = compareEvmBalanceDeltas(
      [
        ...changes,
        { address: "0x0000000000000000000000000000000000000001", asset: "ETH", delta: "1" },
      ],
      [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-100",
          maxDelta: "-100",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("unexpected balance change");
  });

  it("allows unexpected zero balance changes", () => {
    const result = compareEvmBalanceDeltas(
      [
        ...changes,
        { address: "0x0000000000000000000000000000000000000001", asset: "ETH", delta: "0" },
      ],
      [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-100",
          maxDelta: "-100",
        },
      ],
    );

    expect(result.passed).toBe(true);
  });

  it("fails unexpected malformed balance changes when no changes are expected", () => {
    const result = compareEvmBalanceDeltas(
      [{ address: "0x0000000000000000000000000000000000000001", asset: "ETH", delta: "bad" }],
      [],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("unexpected balance change");
  });

  it("fails malformed simulated balance change shapes", () => {
    const result = compareEvmBalanceDeltas([{ asset: "ETH", delta: "1" } as never], []);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("address-based integer entries");
  });

  it("fails null and primitive simulated balance change rows", () => {
    const result = compareEvmBalanceDeltas([null, 42] as never, []);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]?.reason).toContain("address-based integer entries");
  });
});
