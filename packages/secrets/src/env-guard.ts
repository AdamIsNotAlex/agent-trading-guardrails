import type { Environment } from "./interfaces.js";

export function assertNotVaultDevInProduction(environment: Environment, vaultAddr: string): void {
  if (environment !== "canary_live" && environment !== "production") return;

  const parseTarget = /^[a-z][a-z0-9+.-]*:\/\//i.test(vaultAddr)
    ? vaultAddr
    : `http://${vaultAddr}`;
  let url: URL;
  try {
    url = new URL(parseTarget);
  } catch {
    throw new Error(`Vault address (${vaultAddr}) is not a valid URL.`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Vault address (${vaultAddr}) must use HTTPS in ${environment} environment.`);
  }
}
