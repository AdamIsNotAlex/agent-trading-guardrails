# Key Rotation and Emergency Revocation Runbook

## Routine Key Rotation

### CEX API Keys
1. Generate new API key in Binance with identical permissions (no-withdrawal, IP allowlist).
2. Store new key in Vault at the same path.
3. Verify broker can authenticate with new key.
4. Disable old API key in Binance.
5. Audit log the rotation event.

### Wallet Keys (Testnet/Devnet)
1. Generate new keypair using the signer backend.
2. Fund new address from faucet.
3. Update configuration to use new address.
4. Verify signing works with new key.
5. Audit log the rotation event.

### Vault Token
1. Create new Vault token with same policy.
2. Update broker configuration.
3. Verify secret access with new token.
4. Revoke old token.

## Emergency Revocation

### CEX API Key Compromised
1. **Immediately** disable the API key in Binance dashboard.
2. Activate global kill switch.
3. Review audit log for unauthorized activity.
4. Generate new API key with no-withdrawal and IP allowlist.
5. Store in Vault and restart broker.
6. Deactivate kill switch after verification.

### Wallet Key Compromised
1. Activate chain-specific kill switch.
2. If funds at risk, transfer remaining funds to a new address (manual intervention).
3. Generate new keypair.
4. Update configuration.
5. Review audit log for unauthorized transactions.

### Vault Token Compromised
1. Revoke the token immediately via Vault CLI or API.
2. Rotate all secrets stored in Vault.
3. Generate new Vault token.
4. Update all services that use the token.
5. Audit Vault access logs.

### LLM API Key Compromised
1. Revoke the key at the provider.
2. Generate new key.
3. Update proxy or secret manager.
4. No trading impact — reviewer temporarily unavailable (system fails closed).
