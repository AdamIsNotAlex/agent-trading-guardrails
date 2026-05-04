# Signing Backend Requirements

## KMS Adapter Requirements

- Integrate with cloud KMS (AWS KMS, GCP Cloud KMS, Azure Key Vault).
- Support asymmetric signing operations (ECDSA for EVM, EdDSA for Solana).
- Key material never leaves KMS boundary.
- Implement `SignerBackend` interface.
- Support key rotation via KMS key versioning.
- Audit log all signing requests via KMS audit trails.

## HSM Adapter Requirements

- Integrate with PKCS#11 or vendor-specific HSM APIs.
- Support hardware-backed key generation and signing.
- Key material stored in tamper-resistant hardware.
- Implement `SignerBackend` interface.
- Support key rotation and certificate management.
- Require physical or multi-party authorization for key export (if ever needed).

## MPC Adapter Requirements

- Integrate with threshold signing protocols (e.g., TSS, Fireblocks, Lit Protocol).
- Distribute key shares across multiple parties/nodes.
- No single party holds the complete private key.
- Implement `SignerBackend` interface.
- Support configurable threshold (e.g., 2-of-3, 3-of-5).
- Audit log all signing ceremonies.

## Key Rotation and Emergency Revocation

See [docs/key-rotation-runbook.md](key-rotation-runbook.md).
