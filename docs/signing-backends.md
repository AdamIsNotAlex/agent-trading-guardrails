# Signing Backend Requirements

## Built-in Testnet Simulation Before Signing

`SepoliaRpcProvider` and `DevnetSolanaRpcProvider` extract balance changes from RPC execution
state. Their connectors bind simulation to the actual signer, compare every observed effect
with `expectedDeltas`, and only then call `signAndBroadcast`. Missing, inconsistent, unsupported,
or out-of-range evidence still refuses signing. RPC remains a trusted state source; the
`balanceChangesReliable` flag is not a cryptographic proof of the remote node's honesty.

These are package-level connectors, not a new standalone Broker/Compose execution mode.
Supply an actual `EvmSigner` or `SolanaSigner` implementation with custody, authorization,
fee limits, and broadcasting outside Agent. `LocalDevSigner` and `LocalDevSolanaSigner` remain
test doubles returning synthetic identifiers; they do not produce real signatures. The
separate local offline Sepolia signer does not automatically broadcast or run these providers.

### Ethereum Sepolia

- The RPC must report chain ID `11155111` and support Geth-compatible `debug_traceCall`
  with both `callTracer` and `prestateTracer` (`diffMode: true`). ERC-20 observation additionally
  needs `eth_getStorageAt` and `eth_call` with state overrides. An `eth_call`-only endpoint
  cannot attest complete effects and is refused; do not expose a node's debug API publicly.
- Calls are pinned to one block number and its hash is checked again before returning.
  `callTracer` proves execution success and supplies actual simulated gas usage. The state
  diff supplies native balances and storage changes. Transfer events and calldata are never
  substituted for balances.
- Native asset ID is `ETH`, in wei. Each configured ERC-20 has a unique `asset` ID, preferably
  its contract address, and a **required, operator-audited** `balanceSlot`. This asserts a
  standard `mapping(address => uint256)` layout; there is no default slot or symbol lookup.
  Optional `allowanceSlot` and `totalSupplySlot` classify those non-balance storage changes.
  ERC-20 `balanceOf` must agree with both the pinned pre-state storage and the simulated
  post-state overrides. Arbitrary/rebasing storage models are not automatically supported.
- Observation includes the signer, destination, expected-delta addresses, configured
  `observedAccounts`, `allowedRecipients`, and `allowedSpenders`. Any unclassified storage
  write, including a transfer to an unobserved account, rejects reliability. Code changes,
  malformed traces, missing RPC capabilities, layout mismatches, and detected reorgs also reject.
- `fromAddress` is an optional trusted fallback for simulation without a signer. Signing
  always uses `signer.getAddress()`. Configure tokens on the provider itself, not just on
  the connector; passing the same config to both is supported.
- Simulation uses `gasPrice: 0`: ETH deltas describe **execution effects excluding gas fees**.
  The signer must separately bound the actual gas/fee envelope. The connector's existing
  function, contract, recipient, approval, and expected-delta checks remain mandatory.

```ts
const provider = new SepoliaRpcProvider({
  rpcUrl,
  fromAddress: signer.getAddress(),
  observedAccounts: [recipientAddress],
  erc20Tokens: [{
    address: tokenAddress,
    asset: tokenAddress,
    balanceSlot: auditedBalanceSlot,
  }],
});
```

Declare expected entries for both the token debit and credit; declaring only a recipient
credit does not authorize the sender's debit. Exact zero expectations are supported for
observed assets. Amounts are raw integer units, never floating-point display balances.

### Solana Devnet

- The RPC must report devnet's genesis hash and support `getMultipleAccounts` and
  `simulateTransaction` with returned base64 account snapshots. The provider observes all
  compiled account keys, including fee payer, program accounts, and read-only mint accounts.
- Pre-state reads and simulation use `finalized` commitment. Simulation sets `minContextSlot`
  to the snapshot slot and additionally requires **exact equality** of the returned slot.
  `minContextSlot` alone is only a lower bound. An advanced/mixed slot refuses signing instead
  of subtracting unrelated states. At most 100 accounts are observed in one snapshot; the
  provider does not mix multiple batches or support address lookup tables.
- `feePayer` can be configured for simulation-only use. Signing passes
  `signer.getPublicKey()` explicitly; a conflicting configured payer is refused. A missing
  payer is also refused, rather than inferred from expected balances.
- Native asset ID is `SOL`, in lamports, **including the actual simulated fee debit**.
  SPL asset IDs are mint public keys, with raw `u64` token amounts decoded using `bigint`.
  Include the fee payer's SOL debit in `expectedDeltas`, even for a token-only transfer.
  Account creation/closure and observed zero balances are accounted for.
- Classic token accounts and Token-2022 public amounts are supported. Token-2022 mint and
  account extensions are checked in both snapshots. Confidential/unknown extensions,
  unsupported layouts (including multisig authority accounts), missing mint snapshots,
  malformed/truncated account data, and lamport values outside JavaScript's safe-integer
  range refuse reliability rather than silently dropping effects.
- For real connector instructions, supply `programId`, `keys` (`pubkey`, `isSigner`,
  `isWritable`), and canonical base64 or `0x`-hex `data`. Trusted decoding accepts System
  `Transfer` and SPL/Token-2022 `TransferChecked`, deriving addresses and mint from the keys.
  Caller-supplied `type` alongside encoded data, `SetAuthority`, unchecked token transfers,
  and other unsupported opcodes remain rejected. Decoded and observed mints must be allowlisted.

```ts
const provider = new DevnetSolanaRpcProvider({
  rpcUrl,
  feePayer: signer.getPublicKey(),
});
```

### Verification

Colocated provider integration tests cover reliable changes, precision, incomplete evidence,
wrong environments, signing identity, and refusal before signing. Local execution smoke was
also exercised with Anvil 1.7.1 (ETH effects and signed/mined ERC-20 transfer) and LiteSVM
(signed SOL and SPL `TransferChecked` execution with signature verification). Mismatched
expected deltas were rejected before broadcasting. These checks used local disposable
ledgers and ephemeral keys, not funded public Sepolia/devnet accounts.

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
