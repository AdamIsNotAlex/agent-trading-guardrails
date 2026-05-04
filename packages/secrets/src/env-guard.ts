import type { Environment } from "./interfaces.js";

export function assertNotVaultDevInProduction(environment: Environment, vaultAddr: string): void {
  if (
    (environment === "canary_live" || environment === "production") &&
    vaultAddr.includes("127.0.0.1:8200")
  ) {
    throw new Error(
      `Vault dev server (${vaultAddr}) cannot be used in ${environment} environment.`,
    );
  }
}
