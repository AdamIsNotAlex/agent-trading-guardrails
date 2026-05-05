import { ethereumSepoliaSigning, ethereumSepoliaSimulation } from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import { EvmConnector } from "./connector.js";
import { decodeTransaction, isUnlimitedApproval } from "./decoder.js";
import { LocalDevSigner } from "./dev-signer.js";
import type { EvmConfig, EvmRpcProvider, SimulationResult } from "./interfaces.js";

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const RECIPIENT_ADDRESS = "0x7265636970696e74000000000000000000000000";

const config: EvmConfig = {
  rpcUrl: "https://sepolia.example.com",
  chainId: 11155111,
  chainEnvironment: "sepolia",
  allowedContracts: [USDC_ADDRESS],
  allowedFunctions: ["transfer", "approve", "0xa9059cbb", "0x095ea7b3"],
  allowedTokens: [USDC_ADDRESS],
  allowedSpenders: ["0x0000000000000000000000007265636970696e74"],
  allowedRecipients: [RECIPIENT_ADDRESS],
};

function makeMockProvider(opts?: {
  simulationSuccess?: boolean;
  balanceChanges?: SimulationResult["balanceChanges"];
  balanceChangesReliable?: boolean;
}): EvmRpcProvider {
  return {
    async simulateTransaction() {
      const success = opts?.simulationSuccess ?? true;
      return {
        success,
        gasUsed: 21000,
        balanceChanges: opts?.balanceChanges ?? [
          { address: RECIPIENT_ADDRESS, asset: "USDC", delta: "100" },
        ],
        balanceChangesReliable: opts?.balanceChangesReliable ?? true,
        error: success ? null : "execution reverted",
      };
    },
    async getBalance() {
      return "1000000000000000000";
    },
    async getBlockNumber() {
      return 12345678;
    },
  };
}

describe("Transaction decoding", () => {
  it("decodes ERC-20 transfer", () => {
    const data =
      "0xa9059cbb0000000000000000000000007265636970696e740000000000000000000000000000000000000000000000000000000000000000000000000000000000000064";
    const decoded = decodeTransaction(USDC_ADDRESS, data);
    expect(decoded.functionSelector).toBe("0xa9059cbb");
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.isApproval).toBe(false);
  });

  it("decodes ERC-20 approval", () => {
    const spender = "7265636970696e740000000000000000000000000";
    const amount = "0000000000000000000000000000000000000000000000000000000000000064";
    const data = `0x095ea7b3000000000000000000000000${spender.slice(0, 40)}${amount}`;
    const decoded = decodeTransaction(USDC_ADDRESS, data);
    expect(decoded.functionName).toBe("approve");
    expect(decoded.isApproval).toBe(true);
    expect(decoded.token).toBe(USDC_ADDRESS);
    expect(decoded.spender).toBeTruthy();
  });

  it("detects unlimited approval", () => {
    const spender = "7265636970696e740000000000000000000000000";
    const unlimited = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const data = `0x095ea7b3000000000000000000000000${spender.slice(0, 40)}${unlimited}`;
    const decoded = decodeTransaction(USDC_ADDRESS, data);
    expect(isUnlimitedApproval(decoded)).toBe(true);
  });

  it("non-approval is not unlimited", () => {
    const data =
      "0xa9059cbb0000000000000000000000007265636970696e740000000000000000000000000000000000000000000000000000000000000000000000000000000000000064";
    const decoded = decodeTransaction(USDC_ADDRESS, data);
    expect(isUnlimitedApproval(decoded)).toBe(false);
  });
});

describe("EvmConnector revalidation", () => {
  it("passes for known contract with allowed function", async () => {
    const connector = new EvmConnector(config, makeMockProvider(), null);
    const result = await connector.revalidate(ethereumSepoliaSimulation);
    expect(result.passed).toBe(true);
  });

  it("rejects unknown contract", async () => {
    const connector = new EvmConnector(config, makeMockProvider(), null);
    const intent = { ...ethereumSepoliaSimulation, to: "0xUNKNOWN_CONTRACT_ADDRESS_HERE_1234" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not in the allowlist");
  });

  it("rejects unlimited approval", async () => {
    const spender = "7265636970696e740000000000000000000000000";
    const unlimited = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const data = `0x095ea7b3000000000000000000000000${spender.slice(0, 40)}${unlimited}`;
    const connector = new EvmConnector(config, makeMockProvider(), null);
    const intent = { ...ethereumSepoliaSimulation, data };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Unlimited");
  });
});

describe("EvmConnector execution", () => {
  it("simulates transaction successfully", async () => {
    const connector = new EvmConnector(config, makeMockProvider(), null);
    const result = await connector.execute(ethereumSepoliaSimulation);
    expect(result.transactionHash).toBeUndefined();
  });

  it("throws when simulate-transaction expected deltas use the wrong shape", async () => {
    const connector = new EvmConnector(config, makeMockProvider(), null);
    const intent = {
      ...ethereumSepoliaSimulation,
      expectedDeltas: [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "USDC",
          minDelta: "0",
          maxDelta: "0",
        },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow("address-based");
  });

  it("throws when simulated balance deltas are outside the expected range", async () => {
    const connector = new EvmConnector(
      config,
      makeMockProvider({
        balanceChanges: [{ address: RECIPIENT_ADDRESS, asset: "USDC", delta: "-100" }],
      }),
      null,
    );
    const intent = {
      ...ethereumSepoliaSimulation,
      expectedDeltas: [
        { address: RECIPIENT_ADDRESS, asset: "USDC", minDelta: "-50", maxDelta: "0" },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow("Balance delta check failed");
  });

  it("throws on failed simulation", async () => {
    const connector = new EvmConnector(
      config,
      makeMockProvider({ simulationSuccess: false }),
      null,
    );
    await expect(connector.execute(ethereumSepoliaSimulation)).rejects.toThrow("Simulation failed");
  });

  it("does not sign request-signature intents without expected deltas", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(config, makeMockProvider(), signer);
    const { expectedDeltas: _, ...intent } = ethereumSepoliaSigning;

    await expect(connector.execute(intent as never)).rejects.toThrow(
      "Ethereum expected balance deltas are required",
    );
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("signs when request-signature balance deltas are within range", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const provider = makeMockProvider({
      balanceChanges: [{ address: RECIPIENT_ADDRESS, asset: "USDC", delta: "-100" }],
    });
    const simulateTransaction = vi.spyOn(provider, "simulateTransaction");
    const connector = new EvmConnector(config, provider, signer);
    const intent = {
      ...ethereumSepoliaSigning,
      expectedDeltas: [
        { address: RECIPIENT_ADDRESS, asset: "USDC", minDelta: "-101", maxDelta: "-99" },
      ],
    };

    const result = await connector.execute(intent as never);

    expect(result.transactionHash).toBeTruthy();
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(signAndBroadcast).toHaveBeenCalledOnce();
  });

  it("does not sign when request-signature expected deltas are not an array", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(config, makeMockProvider(), signer);
    const intent = { ...ethereumSepoliaSigning, expectedDeltas: "invalid" };

    await expect(connector.execute(intent as never)).rejects.toThrow("must be an array");
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sign when request-signature expected deltas use hybrid shapes", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(config, makeMockProvider(), signer);
    const intent = {
      ...ethereumSepoliaSigning,
      expectedDeltas: [
        {
          address: RECIPIENT_ADDRESS,
          account: "recipient111111111111111111111111111111111",
          asset: "USDC",
          minDelta: "0",
          maxDelta: "0",
        },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow(
      "address-based integer entries",
    );
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sign when request-signature expected deltas use the wrong shape", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(config, makeMockProvider(), signer);
    const intent = {
      ...ethereumSepoliaSigning,
      expectedDeltas: [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "USDC",
          minDelta: "0",
          maxDelta: "0",
        },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow("address-based");
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sign when request-signature balance deltas are outside the expected range", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(
      config,
      makeMockProvider({
        balanceChanges: [{ address: RECIPIENT_ADDRESS, asset: "USDC", delta: "-100" }],
      }),
      signer,
    );
    const intent = {
      ...ethereumSepoliaSigning,
      expectedDeltas: [
        { address: RECIPIENT_ADDRESS, asset: "USDC", minDelta: "-50", maxDelta: "0" },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow("Balance delta check failed");
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sign when request-signature expects no balance changes", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const provider = makeMockProvider({
      balanceChanges: [{ address: RECIPIENT_ADDRESS, asset: "USDC", delta: "-100" }],
    });
    const simulateTransaction = vi.spyOn(provider, "simulateTransaction");
    const connector = new EvmConnector(config, provider, signer);
    const intent = { ...ethereumSepoliaSigning, expectedDeltas: [] };

    await expect(connector.execute(intent as never)).rejects.toThrow(
      "Ethereum expected balance deltas are required",
    );
    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sign when request-signature provider cannot verify balance deltas", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new EvmConnector(
      config,
      makeMockProvider({ balanceChangesReliable: false }),
      signer,
    );
    const intent = {
      ...ethereumSepoliaSigning,
      expectedDeltas: [
        { address: RECIPIENT_ADDRESS, asset: "USDC", minDelta: "-101", maxDelta: "-99" },
      ],
    };

    await expect(connector.execute(intent as never)).rejects.toThrow("reliable balance changes");
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("throws when signing without signer configured", async () => {
    const connector = new EvmConnector(config, makeMockProvider(), null);
    await expect(connector.execute(ethereumSepoliaSigning)).rejects.toThrow(
      "Signer not configured",
    );
  });
});

describe("LocalDevSigner", () => {
  it("returns configured address", () => {
    const signer = new LocalDevSigner("0xtest", config);
    expect(signer.getAddress()).toBe("0xtest");
  });

  it("does not expose private keys", () => {
    const signer = new LocalDevSigner("0xtest", config);
    const keys = Object.keys(signer);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("key");
    expect(keys).not.toContain("secret");
  });

  it("rejects mainnet configuration", () => {
    expect(() => new LocalDevSigner("0xtest", { chainEnvironment: "mainnet" })).toThrow("Sepolia");
  });

  it("rejects missing environment configuration", () => {
    expect(() => new LocalDevSigner("0xtest", undefined as never)).toThrow("Sepolia");
  });
});
