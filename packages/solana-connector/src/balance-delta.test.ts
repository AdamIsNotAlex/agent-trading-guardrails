import { describe, expect, it } from "vitest";
import { compareSolanaBalanceDeltas } from "./balance-delta.js";

const changes = [
  {
    account: "recipient111111111111111111111111111111111",
    asset: "SOL",
    delta: "-5000",
  },
];

describe("compareSolanaBalanceDeltas", () => {
  it("passes exact matches", () => {
    const result = compareSolanaBalanceDeltas(changes, [
      {
        account: "recipient111111111111111111111111111111111",
        asset: "SOL",
        minDelta: "-5000",
        maxDelta: "-5000",
      },
    ]);

    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it("aggregates duplicate matching deltas", () => {
    const result = compareSolanaBalanceDeltas(
      [
        { ...changes[0], delta: "-3000" },
        { ...changes[0], delta: "-2000" },
      ],
      [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "-5000",
          maxDelta: "-5000",
        },
      ],
    );

    expect(result.passed).toBe(true);
  });

  it("passes deltas within tolerance", () => {
    const result = compareSolanaBalanceDeltas(changes, [
      {
        account: "recipient111111111111111111111111111111111",
        asset: "SOL",
        minDelta: "-5001",
        maxDelta: "-4999",
      },
    ]);

    expect(result.passed).toBe(true);
  });

  it("fails missing expected changes", () => {
    const result = compareSolanaBalanceDeltas(
      [],
      [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "0",
          maxDelta: "0",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("not present");
  });

  it("fails malformed delta values", () => {
    const result = compareSolanaBalanceDeltas(
      [{ ...changes[0], delta: 1 as never }],
      [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "0",
          maxDelta: "10",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("integer strings");
  });

  it("fails malformed expected ranges", () => {
    const result = compareSolanaBalanceDeltas(changes, [
      {
        account: "recipient111111111111111111111111111111111",
        asset: "SOL",
        minDelta: "-1.5",
        maxDelta: "10",
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("integer strings");
  });

  it("fails out-of-range deltas", () => {
    const result = compareSolanaBalanceDeltas(changes, [
      {
        account: "recipient111111111111111111111111111111111",
        asset: "SOL",
        minDelta: "0",
        maxDelta: "5000",
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatchObject({
      account: "recipient111111111111111111111111111111111",
      asset: "SOL",
    });
    expect(result.reasons[0]?.reason).toContain("outside expected range");
  });

  it("fails unexpected nonzero balance changes", () => {
    const result = compareSolanaBalanceDeltas(
      [
        ...changes,
        { account: "extra111111111111111111111111111111111111", asset: "SOL", delta: "1" },
      ],
      [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "-5000",
          maxDelta: "-5000",
        },
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("unexpected balance change");
  });

  it("allows unexpected zero balance changes", () => {
    const result = compareSolanaBalanceDeltas(
      [
        ...changes,
        { account: "extra111111111111111111111111111111111111", asset: "SOL", delta: "0" },
      ],
      [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "-5000",
          maxDelta: "-5000",
        },
      ],
    );

    expect(result.passed).toBe(true);
  });

  it("fails unexpected malformed balance changes when no changes are expected", () => {
    const result = compareSolanaBalanceDeltas(
      [{ account: "extra111111111111111111111111111111111111", asset: "SOL", delta: "bad" }],
      [],
    );

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("unexpected balance change");
  });

  it("fails malformed simulated balance change shapes", () => {
    const result = compareSolanaBalanceDeltas([{ asset: "SOL", delta: "1" } as never], []);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.reason).toContain("account-based integer entries");
  });

  it("fails null and primitive simulated balance change rows", () => {
    const result = compareSolanaBalanceDeltas([null, 42] as never, []);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]?.reason).toContain("account-based integer entries");
  });
});
