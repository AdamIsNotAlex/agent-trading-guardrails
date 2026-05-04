import { describe, expect, it } from "vitest";
import { assertNotVaultDevInProduction } from "./env-guard.js";
import { LocalSecretProvider } from "./local-provider.js";
import { LocalTestnetSigner } from "./local-signer.js";
import { redactObject, redactSecrets } from "./redaction.js";

describe("LocalSecretProvider", () => {
  it("stores and retrieves secrets", async () => {
    const provider = new LocalSecretProvider({ "api-key": "test-value" });
    expect(await provider.get("api-key")).toBe("test-value");
  });

  it("returns null for missing keys", async () => {
    const provider = new LocalSecretProvider();
    expect(await provider.get("missing")).toBeNull();
  });

  it("sets and deletes secrets", async () => {
    const provider = new LocalSecretProvider();
    await provider.set("key", "val");
    expect(await provider.get("key")).toBe("val");
    await provider.delete("key");
    expect(await provider.get("key")).toBeNull();
  });

  it("lists all keys", async () => {
    const provider = new LocalSecretProvider({ a: "1", b: "2" });
    const keys = await provider.list();
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });
});

describe("LocalTestnetSigner", () => {
  it("signs data and returns bytes", async () => {
    const signer = new LocalTestnetSigner();
    const sig = await signer.sign(new Uint8Array([1, 2, 3]));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(32);
  });

  it("returns public key and address", () => {
    const signer = new LocalTestnetSigner();
    expect(signer.getPublicKey()).toBeTruthy();
    expect(signer.getAddress()).toMatch(/^0x[0-9a-f]+$/);
  });

  it("does not expose key material through public API", () => {
    const signer = new LocalTestnetSigner();
    const json = JSON.stringify(signer);
    expect(json).not.toContain("keyMaterial");
    const descriptor = Object.getOwnPropertyDescriptor(signer, "keyMaterial");
    expect(descriptor).toBeUndefined();
  });
});

describe("assertNotVaultDevInProduction", () => {
  it("allows dev server in dev environment", () => {
    expect(() => assertNotVaultDevInProduction("dev", "http://127.0.0.1:8200")).not.toThrow();
  });

  it("allows dev server in testnet environment", () => {
    expect(() => assertNotVaultDevInProduction("testnet", "http://127.0.0.1:8200")).not.toThrow();
  });

  it("rejects dev server in canary_live", () => {
    expect(() => assertNotVaultDevInProduction("canary_live", "http://127.0.0.1:8200")).toThrow(
      "cannot be used",
    );
  });

  it("rejects dev server in production", () => {
    expect(() => assertNotVaultDevInProduction("production", "http://127.0.0.1:8200")).toThrow(
      "cannot be used",
    );
  });

  it("allows non-dev vault in production", () => {
    expect(() =>
      assertNotVaultDevInProduction("production", "https://vault.example.com"),
    ).not.toThrow();
  });
});

describe("Secret redaction", () => {
  it("redacts hex private keys", () => {
    const text = `key is 0x${"a".repeat(64)}`;
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("a".repeat(64));
  });

  it("redacts PEM private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\ndata\n-----END RSA PRIVATE KEY-----";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts secret fields in objects", () => {
    const obj = {
      name: "test",
      apiSecret: "super-secret-value",
      privateKey: "0x123",
      config: { mnemonic: "word1 word2" },
    };
    const redacted = redactObject(obj) as Record<string, unknown>;
    expect(redacted.name).toBe("test");
    expect(redacted.apiSecret).toBe("[REDACTED]");
    expect(redacted.privateKey).toBe("[REDACTED]");
    expect((redacted.config as Record<string, unknown>).mnemonic).toBe("[REDACTED]");
  });

  it("secrets are never returned through agent-facing API shape", () => {
    const agentResponse = {
      intentId: "test",
      outcome: "allow",
      reasons: [],
      apiKey: "leaked-key",
      secret: "leaked-secret",
    };
    const safe = redactObject(agentResponse) as Record<string, unknown>;
    expect(safe.apiKey).toBe("[REDACTED]");
    expect(safe.secret).toBe("[REDACTED]");
    expect(safe.intentId).toBe("test");
  });
});
