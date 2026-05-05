import type { SecretProvider } from "./interfaces.js";

export interface VaultConfig {
  addr: string;
  token: string;
  mountPath: string;
}

export class VaultSecretProvider implements SecretProvider {
  constructor(private config: VaultConfig) {}

  async get(key: string): Promise<string | null> {
    const res = await fetch(this.url("data", key), {
      headers: { "X-Vault-Token": this.config.token },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Vault get failed: ${res.status}`);
    const body = (await res.json()) as { data?: { data?: Record<string, string> } };
    return body.data?.data?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const res = await fetch(this.url("data", key), {
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
    const res = await fetch(this.url("metadata", key), {
      method: "DELETE",
      headers: { "X-Vault-Token": this.config.token },
    });
    if (!res.ok) throw new Error(`Vault delete failed: ${res.status}`);
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.url("metadata")}?list=true`, {
      headers: { "X-Vault-Token": this.config.token },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Vault list failed: ${res.status}`);
    const body = (await res.json()) as { data?: { keys?: string[] } };
    return body.data?.keys ?? [];
  }

  private url(segment: "data" | "metadata", key?: string): string {
    const addr = this.config.addr.replace(/\/+$/, "");
    const mountPath = this.encodePath(this.config.mountPath);
    const keyPath = key == null ? "" : `/${this.encodePath(key)}`;
    return `${addr}/v1/${mountPath}/${segment}${keyPath}`;
  }

  private encodePath(path: string): string {
    return path
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => {
        if (part === "." || part === "..") {
          throw new Error("Vault paths must not include dot segments.");
        }
        return encodeURIComponent(part);
      })
      .join("/");
  }
}
