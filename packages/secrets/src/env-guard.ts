import type { Environment } from "./interfaces.js";

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isLoopbackVaultHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized.startsWith("127.") ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:127.") ||
    /^::ffff:7f[0-9a-f]{2}:/.test(normalized)
  );
}

function isVaultDevServer(vaultAddr: string): boolean {
  const normalized = vaultAddr.toLowerCase();
  const parseTarget = /^[a-z][a-z0-9+.-]*:\/\//i.test(vaultAddr)
    ? vaultAddr
    : `http://${vaultAddr}`;

  try {
    const url = new URL(parseTarget);
    return url.port === "8200" && isLoopbackVaultHost(url.hostname);
  } catch {
    return (
      /127\.[0-9.]*:8200/.test(normalized) ||
      normalized.includes("localhost:8200") ||
      normalized.includes("localhost.:8200") ||
      normalized.includes("[::1]:8200") ||
      normalized.includes("[::ffff:127.") ||
      /\[::ffff:7f[0-9a-f]{2}:/.test(normalized)
    );
  }
}

export function assertNotVaultDevInProduction(environment: Environment, vaultAddr: string): void {
  if (
    (environment === "canary_live" || environment === "production") &&
    isVaultDevServer(vaultAddr)
  ) {
    throw new Error(
      `Vault dev server (${vaultAddr}) cannot be used in ${environment} environment.`,
    );
  }
}
