import type { SecretProvider } from "./interfaces.js";

export interface VaultConfig {
  addr: string;
  token: string;
  mountPath: string;
}

export class VaultSecretProvider implements SecretProvider {
  constructor(private config: VaultConfig) {}

  async get(key: string): Promise<string | null> {
    const url = `${this.config.addr}/v1/${this.config.mountPath}/data/${key}`;
    const res = await fetch(url, {
      headers: { "X-Vault-Token": this.config.token },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { data?: Record<string, string> } };
    return body.data?.data?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const url = `${this.config.addr}/v1/${this.config.mountPath}/data/${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Vault-Token": this.config.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { value } }),
    });
    if (!res.ok) throw new Error(`Vault set failed: ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const url = `${this.config.addr}/v1/${this.config.mountPath}/metadata/${key}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "X-Vault-Token": this.config.token },
    });
    if (!res.ok) throw new Error(`Vault delete failed: ${res.status}`);
  }

  async list(): Promise<string[]> {
    const url = `${this.config.addr}/v1/${this.config.mountPath}/metadata?list=true`;
    const res = await fetch(url, {
      headers: { "X-Vault-Token": this.config.token },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { keys?: string[] } };
    return body.data?.keys ?? [];
  }
}
