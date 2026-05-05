import type { OnchainSigningIntent } from "@guardrails/schemas";
import { solanaDevnetSimulation } from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import { SolanaConnector } from "./connector.js";
import { LocalDevSolanaSigner } from "./dev-signer.js";
import type { SolanaConfig, SolanaRpcProvider } from "./interfaces.js";
import { hasAuthorityChange, parseInstructions } from "./parser.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const config: SolanaConfig = {
  rpcUrl: "https://api.devnet.solana.com",
  chainEnvironment: "devnet",
  allowedPrograms: [TOKEN_PROGRAM, SYSTEM_PROGRAM],
  allowedTokenMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  allowedAccounts: ["recipient111111111111111111111111111111111"],
};

const signingIntent: OnchainSigningIntent = {
  ...solanaDevnetSimulation,
  action: "onchain.request_signature",
  simulationId: "550e8400-e29b-41d4-a716-446655440005",
  intentId: "550e8400-e29b-41d4-a716-446655440007",
  idempotencyKey: "sign-sol-001",
};

function makeMockProvider(opts?: { simulationSuccess?: boolean }): SolanaRpcProvider {
  return {
    async simulateTransaction() {
      const success = opts?.simulationSuccess ?? true;
      return { success, logs: [], balanceChanges: [], error: success ? null : "simulation error" };
    },
    async getBalance() {
      return 1_000_000_000;
    },
    async getSlot() {
      return 12345;
    },
  };
}

describe("Instruction parsing", () => {
  it("parses raw instructions", () => {
    const raw = [{ programId: TOKEN_PROGRAM, type: "transfer", amount: 100 }];
    const parsed = parseInstructions(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].programId).toBe(TOKEN_PROGRAM);
    expect(parsed[0].type).toBe("transfer");
  });

  it("detects authority change", () => {
    const instructions = parseInstructions([{ programId: TOKEN_PROGRAM, type: "setAuthority" }]);
    expect(hasAuthorityChange(instructions)).toBe(true);
  });

  it("no authority change in normal transfer", () => {
    const instructions = parseInstructions([{ programId: TOKEN_PROGRAM, type: "transfer" }]);
    expect(hasAuthorityChange(instructions)).toBe(false);
  });
});

describe("SolanaConnector revalidation", () => {
  it("passes for known program", async () => {
    const connector = new SolanaConnector(config, makeMockProvider(), null);
    const result = await connector.revalidate(solanaDevnetSimulation);
    expect(result.passed).toBe(true);
  });

  it("rejects unknown program", async () => {
    const connector = new SolanaConnector(config, makeMockProvider(), null);
    const intent = {
      ...solanaDevnetSimulation,
      programId: "UnknownProgram111111111111111111",
      to: "UnknownProgram111111111111111111",
    };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not in the allowlist");
  });

  it("rejects authority change", async () => {
    const connector = new SolanaConnector(config, makeMockProvider(), null);
    const intent = {
      ...solanaDevnetSimulation,
      instructions: [{ programId: TOKEN_PROGRAM, type: "setAuthority" }],
    };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Authority");
  });
});

describe("SolanaConnector execution", () => {
  it("simulates transaction successfully", async () => {
    const connector = new SolanaConnector(config, makeMockProvider(), null);
    const result = await connector.execute(solanaDevnetSimulation);
    expect(result.transactionHash).toBeUndefined();
  });

  it("throws on failed simulation", async () => {
    const connector = new SolanaConnector(
      config,
      makeMockProvider({ simulationSuccess: false }),
      null,
    );
    await expect(connector.execute(solanaDevnetSimulation)).rejects.toThrow("Simulation failed");
  });

  it("simulates before signing with dev signer", async () => {
    const calls: string[] = [];
    const simulateTransaction = vi.fn(async () => {
      calls.push("simulate");
      return { success: true, logs: [], balanceChanges: [], error: null };
    });
    const provider: SolanaRpcProvider = {
      simulateTransaction,
      async getBalance() {
        return 1_000_000_000;
      },
      async getSlot() {
        return 12345;
      },
    };
    const signer = new LocalDevSolanaSigner("devnet-pubkey-test", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast").mockImplementation(async () => {
      calls.push("sign");
      return "solana-tx-test";
    });

    const connector = new SolanaConnector(config, provider, signer);
    const result = await connector.execute(signingIntent);

    expect(result.transactionHash).toBe("solana-tx-test");
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(simulateTransaction).toHaveBeenCalledWith(
      parseInstructions([{ programId: signingIntent.programId }]),
    );
    expect(signAndBroadcast).toHaveBeenCalledOnce();
    expect(calls).toEqual(["simulate", "sign"]);
  });

  it("does not sign when request-signature simulation fails", async () => {
    const signer = new LocalDevSolanaSigner("devnet-pubkey-test", config);
    const signAndBroadcast = vi.spyOn(signer, "signAndBroadcast");
    const connector = new SolanaConnector(
      config,
      makeMockProvider({ simulationSuccess: false }),
      signer,
    );

    await expect(connector.execute(signingIntent)).rejects.toThrow("Simulation failed");
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it("throws when signing without signer", async () => {
    const connector = new SolanaConnector(config, makeMockProvider(), null);
    await expect(connector.execute(signingIntent)).rejects.toThrow("Signer not configured");
  });
});

describe("LocalDevSolanaSigner", () => {
  it("returns configured public key", () => {
    const signer = new LocalDevSolanaSigner("test-key", config);
    expect(signer.getPublicKey()).toBe("test-key");
  });

  it("does not expose private keys", () => {
    const signer = new LocalDevSolanaSigner("test-key", config);
    const keys = Object.keys(signer);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("secretKey");
  });

  it("rejects mainnet configuration", () => {
    expect(() => new LocalDevSolanaSigner("test-key", { chainEnvironment: "mainnet" })).toThrow(
      "devnet",
    );
  });

  it("rejects missing environment configuration", () => {
    expect(() => new LocalDevSolanaSigner("test-key", undefined as never)).toThrow("devnet");
  });
});
