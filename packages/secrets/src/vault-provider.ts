import type { SecretProvider } from "./interfaces.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VaultReadOperation = "get" | "list";

function malformedVaultResponse(operation: VaultReadOperation, reason: string): Error {
  return new Error(`Malformed Vault ${operation} response: ${reason}.`);
}

async function readVaultJsonResponse(
  operation: VaultReadOperation,
  res: Response,
): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw malformedVaultResponse(operation, "body must be valid JSON");
  }
}

function parseVaultGetResponse(body: unknown): string {
  if (!isPlainObject(body)) {
    throw malformedVaultResponse("get", "body must be an object");
  }

  const data = body.data;
  if (!isPlainObject(data)) {
    throw malformedVaultResponse("get", "data must be an object");
  }

  const secretData = data.data;
  if (!isPlainObject(secretData)) {
    throw malformedVaultResponse("get", "data.data must be an object");
  }

  const value = secretData.value;
  if (typeof value !== "string") {
    throw malformedVaultResponse("get", "data.data.value must be a string");
  }

  return value;
}

function parseVaultListResponse(body: unknown): string[] {
  if (!isPlainObject(body)) {
    throw malformedVaultResponse("list", "body must be an object");
  }

  const data = body.data;
  if (!isPlainObject(data)) {
    throw malformedVaultResponse("list", "data must be an object");
  }

  const keys = data.keys;
  if (!Array.isArray(keys)) {
    throw malformedVaultResponse("list", "data.keys must be an array");
  }

  for (const key of keys) {
    if (typeof key !== "string") {
      throw malformedVaultResponse("list", "data.keys must contain only strings");
    }
  }

  return keys;
}

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
    return parseVaultGetResponse(await readVaultJsonResponse("get", res));
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
    return parseVaultListResponse(await readVaultJsonResponse("list", res));
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
