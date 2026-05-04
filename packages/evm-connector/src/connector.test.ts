import { ethereumSepoliaSigning, ethereumSepoliaSimulation } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { EvmConnector } from "./connector.js";
import { decodeTransaction, isUnlimitedApproval } from "./decoder.js";
import { LocalDevSigner } from "./dev-signer.js";
import type { EvmConfig, EvmRpcProvider } from "./interfaces.js";

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const config: EvmConfig = {
  rpcUrl: "https://sepolia.example.com",
  chainId: 11155111,
  chainEnvironment: "sepolia",
  allowedContracts: [USDC_ADDRESS],
  allowedFunctions: ["transfer", "approve", "0xa9059cbb", "0x095ea7b3"],
  allowedTokens: [USDC_ADDRESS],
  allowedSpenders: ["0x0000000000000000000000007265636970696e74"],
};

function makeMockProvider(opts?: { simulationSuccess?: boolean }): EvmRpcProvider {
  return {
    async simulateTransaction() {
      const success = opts?.simulationSuccess ?? true;
      return {
        success,
        gasUsed: 21000,
        balanceChanges: [],
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
      "0xa9059cbb000000000000000000000000recipient0000000000000000000000000000000000000000000000000000000000000064";
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
      "0xa9059cbb000000000000000000000000recipient0000000000000000000000000000000000000000000000000000000000000064";
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

  it("throws on failed simulation", async () => {
    const connector = new EvmConnector(
      config,
      makeMockProvider({ simulationSuccess: false }),
      null,
    );
    await expect(connector.execute(ethereumSepoliaSimulation)).rejects.toThrow("Simulation failed");
  });

  it("signs and broadcasts with dev signer", async () => {
    const signer = new LocalDevSigner("0x1234567890abcdef1234567890abcdef12345678");
    const connector = new EvmConnector(config, makeMockProvider(), signer);
    const result = await connector.execute(ethereumSepoliaSigning);
    expect(result.transactionHash).toBeTruthy();
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]+$/);
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
    const signer = new LocalDevSigner("0xtest");
    expect(signer.getAddress()).toBe("0xtest");
  });

  it("does not expose private keys", () => {
    const signer = new LocalDevSigner("0xtest");
    const keys = Object.keys(signer);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("key");
    expect(keys).not.toContain("secret");
  });
});
